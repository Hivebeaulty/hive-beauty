-- ---------------------------------------------------------------------------
-- 0028 — Central de comunicação: ENVIO PARA VÁRIAS CLIENTES pelo WhatsApp
--
-- Liga o botão "Enviar" da central (clientes/comunicacao) à fila que já envia as
-- confirmações. Regras (as mesmas da tela, com o banco como autoridade):
--   * só owner/admin envia; WhatsApp precisa estar conectado;
--   * só clientes da MESMA empresa com autorização registrada (comm_status =
--     'allowed'), celular válido, não arquivadas, sem SAIR — o resto é pulado
--     com o motivo contado;
--   * texto com {nome} e {negocio} (mesma regra de lib/hive/communication.ts) e
--     rodapé fixo de saída: "Para não receber mais mensagens, responda SAIR.";
--   * no máximo campaign_max_recipients (200) por envio; o limite DIÁRIO da
--     empresa (send_per_day) vale para tudo;
--   * espaçamento: a 1ª sai já; cada seguinte no MÍNIMO campaign_spacing_seconds (12 s)
--     depois da anterior, + variação aleatória (proteção contra bloqueio);
--   * idempotente: o mesmo envio (p_request_id) nunca enfileira duas vezes;
--   * fora do limite POR MINUTO de enqueue_send (que protege as confirmações) —
--     única mudança em enqueue_send; confirmações seguem saindo na hora.
-- O worker não muda: são envios comuns da fila (SAIR cancela na hora de enviar).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_send') then
    raise exception '0028 ABORTADA — nada foi alterado. Aplique antes a 0017.' using errcode = '55000';
  end if;
end $$;

-- 1. CONFIGURAÇÃO E REGISTRO ---------------------------------------------------------
alter table whatsapp_private.settings
  add column if not exists campaign_max_recipients int not null default 200 check (campaign_max_recipients between 1 and 1000),
  add column if not exists campaign_spacing_seconds int not null default 12 check (campaign_spacing_seconds between 3 and 600);
alter table whatsapp_private.outbox add column if not exists campaign_id uuid;
create index if not exists wa_outbox_campaign_idx on whatsapp_private.outbox (campaign_id) where campaign_id is not null;

create table if not exists whatsapp_private.campaigns (
  id         uuid primary key,
  company_id uuid not null references companies (id) on delete cascade,
  body       text not null,
  requested  int not null,
  queued     int not null,
  skipped    jsonb not null default '{}'::jsonb,
  first_at   timestamptz,
  last_at    timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists wa_campaigns_company_idx on whatsapp_private.campaigns (company_id, created_at desc);
alter table whatsapp_private.campaigns enable row level security;


-- 2. TEXTO (cópia de renderTemplate em lib/hive/communication.ts + rodapé) ------------
create or replace function whatsapp_private.campaign_text(p_body text, p_client_name text, p_company_name text)
returns text
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  t text := btrim(coalesce(p_body, ''), E' \t\n\r');
  v_nome text := coalesce(nullif((regexp_split_to_array(btrim(coalesce(p_client_name, '')), '\s+'))[1], ''), coalesce(p_client_name, ''));
  m text[];
begin
  for m in select regexp_matches(t, '\{([A-Za-z_]+)\}', 'g') loop
    if lower(m[1]) = 'nome' then t := replace(t, '{' || m[1] || '}', v_nome);
    elsif lower(m[1]) = 'negocio' then t := replace(t, '{' || m[1] || '}', coalesce(p_company_name, ''));
    end if;
  end loop;
  return t || E'\n\nPara não receber mais mensagens, responda SAIR.';
end;
$$;


-- 3. enqueue_send da 0017 com UMA mudança: o limite por minuto ignora envio em massa ---
create or replace function whatsapp_private.enqueue_send(
  p_company_id uuid, p_client_id uuid, p_appointment_id uuid, p_to_phone text, p_body text, p_key text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  st whatsapp_private.settings%rowtype;
  o whatsapp_private.outbox%rowtype;
  v_min int;
  v_day int;
begin
  select * into st from whatsapp_private.settings where id;

  -- idempotência: mesma chave devolve o MESMO pedido; chave reaproveitada com outro conteúdo é erro
  select * into o from whatsapp_private.outbox where company_id = p_company_id and idempotency_key = p_key;
  if found then
    if o.kind <> 'send_text' or o.client_id is distinct from p_client_id or o.body is distinct from p_body
       or o.appointment_id is distinct from p_appointment_id then
      raise exception 'Esta chave de envio já foi usada com outro conteúdo.' using errcode = 'AUW04';
    end if;
    return jsonb_build_object('outbox_id', o.id, 'status', o.status, 'created', false);
  end if;

  -- ritmo por empresa (o worker ainda espaça os envios na W2)
  perform pg_advisory_xact_lock(hashtext('wa_send:' || p_company_id::text));
  select count(*) filter (where created_at > now() - interval '1 minute' and campaign_id is null),  -- [0028] envio em massa tem ritmo próprio
         count(*) filter (where created_at > now() - interval '1 day')
  into v_min, v_day
  from whatsapp_private.outbox
  where company_id = p_company_id and kind = 'send_text' and created_at > now() - interval '1 day';
  if v_min >= st.send_per_minute or v_day >= st.send_per_day then
    raise exception 'Limite de envios atingido. Tente de novo em instantes.' using errcode = 'AUW03';
  end if;

  insert into whatsapp_private.outbox (company_id, kind, client_id, appointment_id, to_phone, body,
                                       idempotency_key, max_attempts, created_by)
  values (p_company_id, 'send_text', p_client_id, p_appointment_id, p_to_phone, p_body,
          p_key, st.outbox_max_attempts, auth.uid())
  on conflict (company_id, idempotency_key) do nothing
  returning * into o;
  if o.id is null then   -- corrida com o mesmo pedido: devolve o que venceu
    select * into o from whatsapp_private.outbox where company_id = p_company_id and idempotency_key = p_key;
    return jsonb_build_object('outbox_id', o.id, 'status', o.status, 'created', false);
  end if;
  return jsonb_build_object('outbox_id', o.id, 'status', o.status, 'created', true);
end;
$$;


-- 4. RPCs DO APP -----------------------------------------------------------------------
create or replace function wa_send_campaign(p_company_id uuid, p_client_ids uuid[], p_body text, p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  st whatsapp_private.settings%rowtype;
  camp whatsapp_private.campaigns%rowtype;
  v_body text := btrim(coalesce(p_body, ''), E' \t\n\r');
  v_company text;
  v_ids uuid[];
  v_unknown text;
  v_sent_day int;
  v_eligible int;
  v_skipped jsonb;
  v_first timestamptz; v_last timestamptz;
  r_cli record; i int := 0; v_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa envia mensagens pela central.' using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'Envio sem identificação.' using errcode = '22023'; end if;

  -- mesmo envio de novo (clique duplo, rede): devolve o resultado, NÃO enfileira de novo
  select * into camp from whatsapp_private.campaigns where id = p_request_id;
  if found then
    if camp.company_id <> p_company_id then raise exception 'Envio não encontrado.' using errcode = 'P0002'; end if;
    return jsonb_build_object('campaign_id', camp.id, 'queued', camp.queued, 'skipped', camp.skipped,
                              'first_at', camp.first_at, 'last_at', camp.last_at, 'repeated', true);
  end if;

  if v_body = '' or char_length(v_body) > 1000 then
    raise exception 'Mensagem vazia ou longa demais (até 1000 caracteres).' using errcode = 'AUW05';
  end if;
  select string_agg(distinct '{' || m[1] || '}', ', ') into v_unknown
  from regexp_matches(v_body, '\{([A-Za-z_]+)\}', 'g') m where lower(m[1]) not in ('nome', 'negocio');
  if v_unknown is not null then
    raise exception 'Variável desconhecida: %.', v_unknown using errcode = 'AUW05';
  end if;
  if not whatsapp_private.session_ready(p_company_id) then
    raise exception 'O WhatsApp da empresa não está conectado.' using errcode = 'AUW01';
  end if;

  select * into st from whatsapp_private.settings where id;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_client_ids, '{}')) x where x is not null;
  if v_ids is null then raise exception 'Selecione pelo menos uma cliente.' using errcode = '22023'; end if;
  if cardinality(v_ids) > st.campaign_max_recipients then
    raise exception 'No máximo % clientes por envio.', st.campaign_max_recipients using errcode = 'AUW06';
  end if;

  -- elegíveis x puladas (com motivo)
  select jsonb_object_agg(reason, n) into v_skipped from (
    select reason, count(*) n from (
      select case when cx.id is null then 'not_found'
                  when whatsapp_private.recipient_block(cx) is not null then whatsapp_private.recipient_block(cx)
                  when cx.comm_status <> 'allowed' then 'consent_unknown' end as reason
      from unnest(v_ids) x left join clients cx on cx.id = x and cx.company_id = p_company_id
    ) z where reason is not null group by reason) y;
  select count(*) into v_eligible from clients ce
  where ce.id = any (v_ids) and ce.company_id = p_company_id
    and whatsapp_private.recipient_block(ce) is null and ce.comm_status = 'allowed';
  if v_eligible = 0 then
    raise exception 'Nenhuma das clientes selecionadas pode receber (sem autorização, sem celular válido ou pediu para sair).' using errcode = 'AUW02';
  end if;

  -- limite diário da empresa (tudo: confirmações, lembretes, avisos e envios em massa)
  perform pg_advisory_xact_lock(hashtext('wa_send:' || p_company_id::text));
  select count(*) into v_sent_day from whatsapp_private.outbox
  where company_id = p_company_id and kind = 'send_text' and created_at > now() - interval '1 day';
  if v_sent_day + v_eligible > st.send_per_day then
    raise exception 'Limite diário de mensagens: hoje ainda dá para enviar para % cliente(s).', greatest(0, st.send_per_day - v_sent_day)
      using errcode = 'AUW03', detail = greatest(0, st.send_per_day - v_sent_day)::text;
  end if;

  select co.name into v_company from companies co where co.id = p_company_id;
  insert into whatsapp_private.campaigns (id, company_id, body, requested, queued, skipped, created_by)
  values (p_request_id, p_company_id, v_body, cardinality(v_ids), 0, coalesce(v_skipped, '{}'::jsonb), auth.uid());

  for r_cli in
    select cl.* from clients cl
    where cl.id = any (v_ids) and cl.company_id = p_company_id
      and whatsapp_private.recipient_block(cl) is null and cl.comm_status = 'allowed'
    order by cl.name, cl.id
  loop
    -- a 1ª sai já; cada seguinte, no MÍNIMO campaign_spacing_seconds depois da anterior (+ variação)
    v_at := case when v_last is null then now()
                 else v_last + make_interval(secs => st.campaign_spacing_seconds + floor(random() * (st.campaign_spacing_seconds / 2 + 1))) end;
    insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key,
                                         max_attempts, available_at, created_by, campaign_id)
    values (p_company_id, 'send_text', r_cli.id, r_cli.phone_normalized,
            whatsapp_private.campaign_text(v_body, r_cli.name, v_company),
            'campaign:' || p_request_id || ':' || r_cli.id, st.outbox_max_attempts, v_at, auth.uid(), p_request_id);
    v_first := least(coalesce(v_first, v_at), v_at); v_last := greatest(coalesce(v_last, v_at), v_at);
    i := i + 1;
  end loop;

  update whatsapp_private.campaigns set queued = i, first_at = v_first, last_at = v_last where id = p_request_id;
  return jsonb_build_object('campaign_id', p_request_id, 'queued', i, 'skipped', coalesce(v_skipped, '{}'::jsonb),
                            'first_at', v_first, 'last_at', v_last, 'repeated', false);
end;
$$;

-- Andamento de um envio (qualquer membro da empresa; sem telefone nem texto)
create or replace function wa_get_campaign(p_campaign_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  camp whatsapp_private.campaigns%rowtype;
  r jsonb;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into camp from whatsapp_private.campaigns where id = p_campaign_id;
  if not found or whatsapp_private.caller_role(camp.company_id) is null then
    raise exception 'Envio não encontrado.' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'waiting', count(*) filter (where o.status in ('pending', 'processing')),
    'sent', count(*) filter (where o.status = 'sent'),
    'read', count(*) filter (where o.status = 'sent' and exists (select 1 from whatsapp_private.messages m where m.outbox_id = o.id and m.status = 'read')),
    'failed', count(*) filter (where o.status = 'failed'),
    'canceled', count(*) filter (where o.status = 'canceled'))
  into r from whatsapp_private.outbox o where o.campaign_id = camp.id and o.company_id = camp.company_id;
  return r || jsonb_build_object('campaign_id', camp.id, 'queued', camp.queued, 'skipped', camp.skipped,
                                 'first_at', camp.first_at, 'last_at', camp.last_at, 'created_at', camp.created_at);
end;
$$;


-- 5. PRIVILÉGIOS ---------------------------------------------------------------------------
revoke all on whatsapp_private.campaigns from public;
revoke all on function whatsapp_private.campaign_text(text, text, text) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on whatsapp_private.campaigns from %I', r);
      execute format('revoke all on function whatsapp_private.campaign_text(text, text, text) from %I', r);
    end if;
  end loop;
end $$;
revoke all on function wa_send_campaign(uuid, uuid[], text, uuid), wa_get_campaign(uuid) from public, anon;
grant execute on function wa_send_campaign(uuid, uuid[], text, uuid), wa_get_campaign(uuid) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function wa_send_campaign(uuid, uuid[], text, uuid), wa_get_campaign(uuid) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
