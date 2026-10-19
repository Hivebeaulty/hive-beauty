-- ---------------------------------------------------------------------------
-- 0035 — Mensagens AUTOMÁTICAS por data + "cliente desde" (aniversário de cliente)
--
--   * clients.client_since: data do PRIMEIRO ATENDIMENTO, editável no cadastro
--     (não é recalculada como first_visit_at). Preenchida com first_visit_at existente.
--   * whatsapp_private.auto_messages: por empresa e tipo — liga/desliga (nasce
--     DESLIGADA), 'system' (2 textos que alternam por ano) ou 'custom'.
--     Tipos: new_year 01/01, womens_day 08/03, selfcare_day 24/07, customer_day 15/09,
--     christmas 25/12, client_anniversary (dia/mês de client_since, a partir de 1 ano).
--   * whatsapp_private.enqueue_auto_messages(): tarefa da 0036 (9h–11h45). Mesma regra
--     da Central: só quem AUTORIZOU (comm_status 'allowed'), celular válido, sem SAIR.
--     1 mensagem por cliente/tipo/ano. Envio espaçado como a Central, dentro do limite
--     diário; confirmações seguem saindo na hora (ritmo próprio).
--   * Textos idênticos à tela: lib/hive/auto-messages.ts.
-- Não altera confirmação, lembrete, avisos, aniversário, Central, fila nem worker.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_birthday_messages') then
    raise exception '0035 ABORTADA — nada foi alterado. Aplique antes a 0031.' using errcode = '55000';
  end if;
end $$;

alter table clients add column if not exists client_since date;
update clients set client_since = first_visit_at where client_since is null and first_visit_at is not null;

create table if not exists whatsapp_private.auto_messages (
  company_id uuid not null references companies (id) on delete cascade,
  kind       text not null check (kind in ('new_year','womens_day','selfcare_day','customer_day','christmas','client_anniversary')),
  enabled    boolean not null default false,
  mode       text not null default 'system' check (mode in ('system', 'custom')),
  template   text check (template is null or char_length(template) <= 2000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, kind)
);
alter table whatsapp_private.auto_messages enable row level security;

create table if not exists whatsapp_private.auto_message_log (
  client_id  uuid not null references clients (id) on delete cascade,
  kind       text not null,
  year       int not null,
  company_id uuid not null references companies (id) on delete cascade,
  status     text not null check (status in ('queued', 'skipped')),
  reason     text,
  outbox_id  uuid references whatsapp_private.outbox (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (client_id, kind, year)
);
alter table whatsapp_private.auto_message_log enable row level security;

-- textos do sistema (cópia de AUTO_SYSTEM_TEMPLATES)
create or replace function whatsapp_private.auto_system_template(p_kind text, p_variant int)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
begin
  case p_kind
    when 'new_year' then return case when p_variant = 0 then 'Feliz Ano-Novo, {nome}! Que o novo ano venha cheio de saúde, alegria e conquistas. Obrigada por estar comigo! ✨' else 'Oi, {nome}! Feliz Ano-Novo! Desejo um ano leve, com muito carinho e motivos para sorrir. 🥂' end;
    when 'womens_day' then return case when p_variant = 0 then 'Feliz Dia da Mulher, {nome}! Que você continue se cuidando e brilhando do seu jeito. 🌸' else 'Oi, {nome}! Hoje é o seu dia: feliz Dia da Mulher! Que nunca falte força, leveza e tempo para você. 💕' end;
    when 'selfcare_day' then return case when p_variant = 0 then 'Oi, {nome}! Hoje é o Dia do Autocuidado, um lembrete carinhoso para separar um tempinho só para você. Você merece! ✨' else 'Feliz Dia do Autocuidado, {nome}! Cuidar de si é um gesto de amor. Quando quiser, estou aqui para esse momento. 🌿' end;
    when 'customer_day' then return case when p_variant = 0 then 'Feliz Dia do Cliente, {nome}! Obrigada pela confiança e por fazer parte da minha história. É um prazer te atender. 💛' else 'Oi, {nome}! Hoje é Dia do Cliente e eu não poderia deixar de agradecer pelo carinho e pela confiança de sempre.' end;
    when 'christmas' then return case when p_variant = 0 then 'Feliz Natal, {nome}! Que sua noite seja cheia de paz, amor e boas lembranças. Obrigada por estar comigo neste ano. 🎄' else 'Oi, {nome}! Desejo um Natal lindo, com muita luz e carinho ao lado de quem você ama. Feliz Natal! ✨' end;
    when 'client_anniversary' then return case when p_variant = 0 then 'Oi, {nome}! Hoje faz {anos} que você confia em mim para se cuidar. Obrigada por cada visita! 💕' else 'Feliz aniversário de parceria, {nome}! Hoje faz {anos} desde o seu primeiro atendimento comigo. Obrigada pelo carinho de sempre! ✨' end;
    else return null;
  end case;
end;
$$;

create or replace function whatsapp_private.auto_variant(p_client_id uuid, p_kind text, p_year int)
returns int language plpgsql immutable set search_path = public, pg_temp as $$
declare v_seed text := p_client_id::text || ':' || p_kind || ':' || p_year::text; v_hash bigint := 0; i int;
begin
  for i in 1 .. char_length(v_seed) loop v_hash := (v_hash * 31 + ascii(substr(v_seed, i, 1))) % 4294967296; end loop;
  return (v_hash % 2)::int;
end;
$$;

-- troca as variáveis e limpa a pontuação (igual a renderAuto)
create or replace function whatsapp_private.auto_render(p_template text, p_client_name text, p_company_name text, p_years int)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
declare
  t text := replace(replace(p_template, E'\r\n', E'\n'), E'\r', E'\n');
  n text := coalesce(nullif((regexp_split_to_array(btrim(coalesce(p_client_name, '')), '\s+'))[1], ''), '');
  m text[]; k text; v text;
begin
  for m in select distinct regexp_matches(t, '\{([^{}\s]{1,30})\}', 'g') loop
    k := whatsapp_private.normalize_variable(m[1]);
    v := case k when 'nome' then n when 'negocio' then btrim(coalesce(p_company_name, ''))
                when 'anos' then case when coalesce(p_years, 0) = 0 then '' when p_years = 1 then '1 ano' else p_years || ' anos' end end;
    if v is not null then t := replace(t, '{' || m[1] || '}', v); end if;
  end loop;
  t := regexp_replace(t, '[ \t]+([,.!?;:])', '\1', 'g');
  t := regexp_replace(t, ',([!?.])', '\1', 'g');
  t := regexp_replace(t, '[ \t]{2,}', ' ', 'g');
  t := regexp_replace(t, '[ \t]+(\n|$)', '\1', 'g');
  return btrim(t, E' \t\n\r');
end;
$$;

create or replace function whatsapp_private.auto_template_problems(p_kind text, p_template text)
returns text[] language plpgsql immutable set search_path = public, pg_temp as $$
declare
  t text := btrim(replace(replace(coalesce(p_template, ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n\r');
  m text[]; unknown text[] := '{}'; problems text[] := '{}'; k text;
begin
  if t = '' then return array['Escreva a mensagem.']; end if;
  if char_length(t) > 1000 then problems := array_append(problems, 'A mensagem passou de 1000 caracteres.'); end if;
  for m in select regexp_matches(t, '\{([^{}\s]{1,30})\}', 'g') loop
    k := whatsapp_private.normalize_variable(m[1]);
    if not (k in ('nome', 'negocio') or (k = 'anos' and p_kind = 'client_anniversary'))
       and not ('{' || m[1] || '}') = any (unknown) then unknown := array_append(unknown, '{' || m[1] || '}'); end if;
  end loop;
  if cardinality(unknown) > 0 then problems := array_append(problems, 'Variável desconhecida: ' || array_to_string(unknown, ', ') || '.'); end if;
  return problems;
end;
$$;

-- disparo diário (tarefa da 0036): só a partir das 9h; idempotente
create or replace function whatsapp_private.enqueue_auto_messages(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_local timestamp := p_now at time zone 'America/Sao_Paulo';
  v_today date := (p_now at time zone 'America/Sao_Paulo')::date;
  v_year int := extract(year from (p_now at time zone 'America/Sao_Paulo'))::int;
  v_leap boolean;
  v_md text := to_char(p_now at time zone 'America/Sao_Paulo', 'MM-DD');
  v_fixed text;
  st whatsapp_private.settings%rowtype;
  co record; r record; cl clients%rowtype;
  v_reason text; v_body text; v_tpl text; v_years int; v_camp uuid; v_at timestamptz; v_last timestamptz; v_key text;
  v_sent int; v_room int; n_q int := 0; n_s int := 0;
begin
  if v_local::time < time '09:00' then return jsonb_build_object('status', 'too_early'); end if;
  v_leap := (v_year % 4 = 0 and v_year % 100 <> 0) or v_year % 400 = 0;
  v_fixed := case v_md when '01-01' then 'new_year' when '03-08' then 'womens_day' when '07-24' then 'selfcare_day'
                       when '09-15' then 'customer_day' when '12-25' then 'christmas' end;
  select * into st from whatsapp_private.settings where id;
  for co in
    select am.company_id, am.kind, am.mode, am.template, c.name as company_name
    from whatsapp_private.auto_messages am join companies c on c.id = am.company_id
    where am.enabled and (am.kind = v_fixed or am.kind = 'client_anniversary')
      and whatsapp_private.session_ready(am.company_id)          -- sem sinal: tenta na próxima rodada
    order by am.company_id, am.kind
  loop
    v_camp := null; v_last := null;
    perform pg_advisory_xact_lock(hashtext('wa_send:' || co.company_id::text));
    select count(*) into v_sent from whatsapp_private.outbox
      where company_id = co.company_id and kind = 'send_text' and created_at > now() - interval '1 day';
    v_room := st.send_per_day - v_sent;
    for r in
      select c.id from clients c
      where c.company_id = co.company_id
        and (co.kind <> 'client_anniversary' or (
              c.client_since is not null and c.client_since <= (v_today - interval '1 year')::date
              and (to_char(c.client_since, 'MM-DD') = v_md or (not v_leap and to_char(c.client_since, 'MM-DD') = '02-29' and v_md = '02-28'))))
        and not exists (select 1 from whatsapp_private.auto_message_log l where l.client_id = c.id and l.kind = co.kind and l.year = v_year)
      order by c.name, c.id
    loop
      select * into cl from clients where id = r.id;
      v_reason := whatsapp_private.recipient_block(cl);
      if v_reason is null and cl.comm_status <> 'allowed' then v_reason := 'consent_unknown'; end if;
      if v_reason is null and v_room <= 0 then v_reason := 'daily_limit'; end if;
      if v_reason is not null then
        insert into whatsapp_private.auto_message_log (client_id, kind, year, company_id, status, reason)
        values (cl.id, co.kind, v_year, co.company_id, 'skipped', v_reason) on conflict do nothing;
        n_s := n_s + 1; continue;
      end if;
      v_years := case when co.kind = 'client_anniversary' then (extract(year from age(v_today, cl.client_since)))::int end;
      v_tpl := case when co.mode = 'custom' and co.template is not null
                         and cardinality(whatsapp_private.auto_template_problems(co.kind, co.template)) = 0 then co.template
                    else whatsapp_private.auto_system_template(co.kind, whatsapp_private.auto_variant(cl.id, co.kind, v_year)) end;
      v_body := whatsapp_private.auto_render(v_tpl, cl.name, co.company_name, v_years);
      if v_camp is null then
        v_camp := gen_random_uuid();
        insert into whatsapp_private.campaigns (id, company_id, body, requested, queued, skipped)
        values (v_camp, co.company_id, 'auto:' || co.kind, 0, 0, '{}'::jsonb);
      end if;
      v_at := case when v_last is null then now()
                   else v_last + make_interval(secs => st.campaign_spacing_seconds + floor(random() * (st.campaign_spacing_seconds / 2 + 1))) end;
      v_key := 'auto:' || co.kind || ':' || cl.id || ':' || v_year;
      insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key, max_attempts, available_at, campaign_id)
      values (co.company_id, 'send_text', cl.id, cl.phone_normalized, v_body, v_key, st.outbox_max_attempts, v_at, v_camp)
      on conflict (company_id, idempotency_key) do nothing;
      insert into whatsapp_private.auto_message_log (client_id, kind, year, company_id, status, outbox_id)
      values (cl.id, co.kind, v_year, co.company_id, 'queued',
              (select o.id from whatsapp_private.outbox o where o.company_id = co.company_id and o.idempotency_key = v_key))
      on conflict do nothing;
      v_last := v_at; v_room := v_room - 1; n_q := n_q + 1;
    end loop;
    if v_camp is not null then
      update whatsapp_private.campaigns c set
        requested = (select count(*) from whatsapp_private.outbox o where o.campaign_id = v_camp),
        queued = (select count(*) from whatsapp_private.outbox o where o.campaign_id = v_camp),
        first_at = (select min(o.available_at) from whatsapp_private.outbox o where o.campaign_id = v_camp), last_at = v_last
      where c.id = v_camp;
    end if;
  end loop;
  return jsonb_build_object('status', 'ok', 'queued', n_q, 'skipped', n_s);
end;
$$;

-- RPCs do app (ler: qualquer membro; mudar: owner/admin)
create or replace function wa_get_auto_messages(p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role member_role;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  return jsonb_build_object('can_manage', v_role in ('owner', 'admin'), 'items', coalesce((
    select jsonb_object_agg(k.kind, jsonb_build_object('enabled', coalesce(am.enabled, false), 'mode', coalesce(am.mode, 'system'), 'template', am.template))
    from unnest(array['new_year','womens_day','selfcare_day','customer_day','christmas','client_anniversary']) k(kind)
    left join whatsapp_private.auto_messages am on am.company_id = p_company_id and am.kind = k.kind), '{}'::jsonb));
end;
$$;

create or replace function wa_set_auto_message(p_company_id uuid, p_kind text, p_enabled boolean, p_mode text, p_template text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role member_role; v_problems text[];
  v_template text := nullif(btrim(replace(replace(coalesce(p_template, ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n\r'), '');
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Só a administração da empresa muda as mensagens automáticas.' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('new_year','womens_day','selfcare_day','customer_day','christmas','client_anniversary')
     or p_enabled is null or p_mode is null or p_mode not in ('system', 'custom') then
    raise exception 'Escolha uma opção válida.' using errcode = '22023';
  end if;
  if p_mode = 'custom' then
    v_problems := whatsapp_private.auto_template_problems(p_kind, v_template);
    if cardinality(v_problems) > 0 then raise exception '%', array_to_string(v_problems, ' ') using errcode = 'AUT01'; end if;
  end if;
  insert into whatsapp_private.auto_messages (company_id, kind, enabled, mode, template, updated_by, updated_at)
  values (p_company_id, p_kind, p_enabled, p_mode, v_template, auth.uid(), now())
  on conflict (company_id, kind) do update set enabled = excluded.enabled, mode = excluded.mode,
    template = coalesce(v_template, whatsapp_private.auto_messages.template), updated_by = excluded.updated_by, updated_at = now();
  return wa_get_auto_messages(p_company_id);
end;
$$;

-- privilégios
revoke all on whatsapp_private.auto_messages, whatsapp_private.auto_message_log from public;
revoke all on function whatsapp_private.auto_system_template(text, int), whatsapp_private.auto_variant(uuid, text, int),
  whatsapp_private.auto_render(text, text, text, int), whatsapp_private.auto_template_problems(text, text),
  whatsapp_private.enqueue_auto_messages(timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on whatsapp_private.auto_messages, whatsapp_private.auto_message_log from %I', r);
      execute format('revoke all on function whatsapp_private.auto_system_template(text, int), whatsapp_private.auto_variant(uuid, text, int), whatsapp_private.auto_render(text, text, text, int), whatsapp_private.auto_template_problems(text, text), whatsapp_private.enqueue_auto_messages(timestamptz) from %I', r);
    end if;
  end loop;
end $$;
revoke all on function wa_get_auto_messages(uuid), wa_set_auto_message(uuid, text, boolean, text, text) from public, anon;
grant execute on function wa_get_auto_messages(uuid), wa_set_auto_message(uuid, text, boolean, text, text) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function wa_get_auto_messages(uuid), wa_set_auto_message(uuid, text, boolean, text, text) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
