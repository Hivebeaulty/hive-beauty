-- ---------------------------------------------------------------------------
-- 0018 — WhatsApp (W5): CONFIRMAÇÃO AUTOMÁTICA de agendamento
--
-- Depende da 0017. Tudo nasce DESLIGADO (chave global auto_confirmation_enabled
-- = false); ligar é um passo de operação separado, com autorização.
--
-- Evento: INSERT em appointments (o agendamento NOVO). Edição, cancelamento e
-- retries NUNCA criam outra confirmação:
--   * o gatilho é só AFTER INSERT;
--   * 1 linha por agendamento em appointment_confirmations (chave primária);
--   * a fila usa a chave de idempotência 'auto-confirmation:<id do agendamento>'.
--
-- Quando o agendamento é criado, o banco decide NA MESMA TRANSAÇÃO:
--   chave global ligada? empresa já configurou WhatsApp (tem sessão)?
--     não → nada é registrado (empresa sem WhatsApp não ganha ruído);
--   preferência da empresa desligada → 'skipped' (disabled);
--   cliente arquivada / bloqueada (inclui SAIR) / sem telefone / inválido / fixo
--     → 'skipped' com o motivo;
--   WhatsApp não conectado ou sem sinal → 'skipped' (not_connected): a tela
--     oferece o envio manual (wa.me), como já fazia;
--   senão → texto montado aqui (mesma regra de lib/hive/appointment-message.ts)
--     e enfileirado → 'queued'.
-- Qualquer erro nessa decisão vira 'skipped' (error/rate_limited) e NUNCA
-- impede o agendamento de ser salvo.
--
-- Na hora de enviar (claim_outbox, redefinida aqui com os mesmos parâmetros):
--   * confirmação cujo agendamento não está mais em aberto e no futuro, ou mudou
--     de cliente, é cancelada (nunca sai mensagem velha);
--   * confirmação automática ainda pendente tem o texto e o telefone REFEITOS
--     com os dados atuais (remarcou → sai o horário novo; "amanhã" continua certo);
--   * envios só são pegos com a sessão 'connected' (sessão caída: ficam pendentes,
--     sem gastar tentativas).
--
-- Não altera dados existentes, nem 0014/0015/0016, nem pagamentos/financeiro.
-- O único objeto novo fora de whatsapp_private é o gatilho AFTER INSERT em
-- appointments (não muda a linha, não bloqueia) e 3 RPCs wa_* para o app.
-- ---------------------------------------------------------------------------

-- 0. PREFLIGHT -----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'whatsapp_private')
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_send') then
    raise exception '0018 ABORTADA — nada foi alterado. Aplique antes a 0017.' using errcode = '55000';
  end if;
end $$;


-- 1. CONFIGURAÇÃO ----------------------------------------------------------------
-- chave global (operação): enquanto false, o gatilho não faz NADA
alter table whatsapp_private.settings
  add column if not exists auto_confirmation_enabled boolean not null default false;
-- preferência da empresa (owner/admin pela tela); vale só quando a chave global está ligada
alter table whatsapp_private.sessions
  add column if not exists auto_confirmation boolean not null default true;

-- registro do que aconteceu com a confirmação de CADA agendamento (1 por agendamento).
-- Sem FK para appointments de propósito: não cria dependência nem gatilho interno na
-- tabela da agenda; agendamento apagado → a fila cancela o envio pendente.
create table if not exists whatsapp_private.appointment_confirmations (
  appointment_id uuid primary key,
  company_id     uuid not null references companies (id) on delete cascade,
  status         text not null check (status in ('queued', 'skipped')),
  reason         text check (reason is null or reason in (
                   'disabled', 'not_connected', 'archived', 'blocked', 'no_phone', 'invalid_phone',
                   'landline', 'no_client', 'rate_limited', 'error')),
  outbox_id      uuid references whatsapp_private.outbox (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint wa_confirmation_shape check ((status = 'queued' and reason is null)
                                         or (status = 'skipped' and reason is not null and outbox_id is null))
);
create index if not exists wa_confirmations_company_idx on whatsapp_private.appointment_confirmations (company_id, created_at);
create index if not exists wa_confirmations_outbox_idx on whatsapp_private.appointment_confirmations (outbox_id);
alter table whatsapp_private.appointment_confirmations enable row level security;


-- 2. TEXTO DA CONFIRMAÇÃO -------------------------------------------------------
-- Port FIEL de buildConfirmationMessage (lib/hive/appointment-message.ts) com
-- variantSeed = id do agendamento (como a tela faz). As duas implementações
-- precisam ficar iguais: teste de paridade em supabase/tests/local/0018_*.
-- Assinatura: nome de exibição da profissional > 1º nome do cadastro (sem o
-- "Profissional" genérico) · nome da empresa. Datas em America/Sao_Paulo.
create or replace function whatsapp_private.confirmation_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text; v_business text; v_display text; v_full text;
  v_local timestamp; v_today date; v_day date;
  v_wd text; v_ddmm text; v_daylabel text; v_time text; v_when text;
  v_nome text; v_minutes int; v_h int; v_m int; v_dur text; v_line text;
  v_p text; v_sign text;
  v_hash bigint := 0; v_seed text; v_variant int; i int;
  v_greet text; v_intro text; v_close text;
  arr text[]; outl text[] := '{}'; v_txt text;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return null; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  select s.name into v_service from services s where s.id = a.service_id;
  select co.name into v_business from companies co where co.id = a.company_id;
  select nullif(btrim(p.display_name), ''), p.full_name into v_display, v_full
  from company_members cm join profiles p on p.id = cm.user_id
  where cm.id = a.professional_member_id and cm.company_id = a.company_id;

  -- quando: "hoje, terça-feira (15/10)" | "amanhã, quarta-feira (16/10)" | "quinta-feira, 17/10", "às 14h30"
  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_day := v_local::date;
  v_today := (p_now at time zone 'America/Sao_Paulo')::date;
  v_wd := wd[extract(dow from v_local)::int + 1];
  v_ddmm := to_char(v_local, 'DD/MM');
  v_daylabel := case when v_day = v_today then 'hoje, ' || v_wd || ' (' || v_ddmm || ')'
                     when v_day = v_today + 1 then 'amanhã, ' || v_wd || ' (' || v_ddmm || ')'
                     else v_wd || ', ' || v_ddmm end;
  v_time := extract(hour from v_local)::int::text || 'h'
            || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;
  v_when := v_daylabel || ', às ' || v_time;

  -- 1º nome da cliente
  v_nome := nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], '');

  -- "Serviço · 1h30" (formatDuration: 45min | 1h | 1h30 | 1h5)
  v_minutes := floor(extract(epoch from (a.scheduled_end - a.scheduled_start)) / 60)::int;
  if v_minutes > 0 then
    v_h := v_minutes / 60; v_m := v_minutes % 60;
    v_dur := case when v_h = 0 then v_m || 'min' when v_m = 0 then v_h || 'h' else v_h || 'h' || v_m end;
  end if;
  v_line := array_to_string(array_remove(array[nullif(btrim(coalesce(v_service, '')), ''), v_dur], null), ' · ');

  -- assinatura: resolveSignatureName + signature()
  v_p := btrim(left(btrim(regexp_replace(coalesce(v_display, ''), '\s+', ' ', 'g')), 40));
  if v_p = '' then v_p := coalesce((regexp_split_to_array(btrim(coalesce(v_full, '')), '\s+'))[1], ''); end if;
  v_business := btrim(coalesce(v_business, ''));
  v_sign := case when v_p <> '' and v_business <> '' and lower(v_p) <> lower(v_business) then v_p || ' · ' || v_business
                 when v_p <> '' then v_p else v_business end;

  -- variação determinística: hash(id) % 3, igual ao JS ((h*31 + code) >>> 0)
  v_seed := a.id::text;
  for i in 1 .. char_length(v_seed) loop
    v_hash := (v_hash * 31 + ascii(substr(v_seed, i, 1))) % 4294967296;
  end loop;
  v_variant := (v_hash % 3)::int;

  v_greet := case v_variant
    when 0 then case when v_nome is not null then 'Oi, ' || v_nome || '! 💛' else 'Oi! 💛' end
    when 1 then case when v_nome is not null then 'Oi, ' || v_nome || ', tudo bem?' else 'Oi, tudo bem?' end
    else case when v_nome is not null then 'Oi, ' || v_nome || '!' else 'Oi!' end end;
  v_intro := case v_variant
    when 0 then 'Seu horário está confirmado: ' || v_when || '.'
    when 1 then 'Passando para confirmar o seu horário: ' || v_when || '.'
    else 'Seu atendimento está marcado para ' || v_when || '.' end;
  v_close := case v_variant
    when 0 then 'Qualquer imprevisto, é só me avisar por aqui. Te espero!'
    when 1 then 'Se precisar remarcar, me avisa por aqui, combinado?'
    else 'Vai ser um prazer te receber! Se algo mudar, é só me chamar por aqui.' end;

  -- mesmas regras de linhas vazias do JS (filtro olha o array ORIGINAL)
  arr := array[v_greet, '', v_intro, v_line, '', v_close, v_sign];
  for i in 1 .. array_length(arr, 1) loop
    if not (arr[i] = '' and (i = 1 or arr[i - 1] = '')) then outl := outl || arr[i]; end if;
  end loop;
  v_txt := regexp_replace(array_to_string(outl, E'\n'), E'\n{3,}', E'\n\n', 'g');
  return btrim(v_txt, E' \n\t\r');
end;
$$;


-- 3. GATILHO: agendamento NOVO → confirmação ----------------------------------------
create or replace function whatsapp_private.on_appointment_created()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_on boolean;
  v_pref boolean;
  c clients%rowtype;
  v_reason text;
  v_body text;
  r jsonb;
begin
  -- caminho rápido: desligado, não é agendamento futuro em aberto, ou empresa sem WhatsApp
  select auto_confirmation_enabled into v_on from whatsapp_private.settings where id;
  if not coalesce(v_on, false) then return null; end if;
  if new.status not in ('agendado', 'confirmado') or new.scheduled_start <= now() then return null; end if;
  select auto_confirmation into v_pref from whatsapp_private.sessions where company_id = new.company_id;
  if not found then return null; end if;

  begin
    if not v_pref then
      v_reason := 'disabled';
    else
      select * into c from clients where id = new.client_id and company_id = new.company_id;
      v_reason := case when not found then 'no_client' else whatsapp_private.recipient_block(c) end;
      if v_reason is null and not whatsapp_private.session_ready(new.company_id) then
        v_reason := 'not_connected';
      end if;
    end if;

    if v_reason is null then
      begin
        v_body := whatsapp_private.confirmation_text(new.id);
        r := whatsapp_private.enqueue_send(new.company_id, c.id, new.id, c.phone_normalized, v_body,
                                           'auto-confirmation:' || new.id);
        insert into whatsapp_private.appointment_confirmations (appointment_id, company_id, status, outbox_id)
        values (new.id, new.company_id, 'queued', (r ->> 'outbox_id')::uuid)
        on conflict (appointment_id) do nothing;
        return null;
      exception when others then
        v_reason := case when sqlstate = 'AUW03' then 'rate_limited' else 'error' end;
        raise warning 'confirmação automática não enfileirada (%)', sqlstate;   -- sem dados pessoais
      end;
    end if;

    insert into whatsapp_private.appointment_confirmations (appointment_id, company_id, status, reason)
    values (new.id, new.company_id, 'skipped', v_reason)
    on conflict (appointment_id) do nothing;
  exception when others then
    -- a confirmação NUNCA impede o agendamento de ser salvo
    raise warning 'confirmação automática ignorada (%)', sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists trg_appointments_wa_auto_confirmation on appointments;
create trigger trg_appointments_wa_auto_confirmation
  after insert on appointments
  for each row execute function whatsapp_private.on_appointment_created();


-- 4. FILA: claim_outbox com as regras de confirmação ---------------------------------
-- Mesmos parâmetros e retorno da 0017 (grants preservados). Mudanças, em ordem:
--   (a) [novo] confirmação (send_text ligado a agendamento) cujo agendamento sumiu,
--       não está em aberto, já começou ou mudou de cliente → cancelada;
--   (b) [novo] confirmação AUTOMÁTICA pendente → texto e telefone refeitos com os dados atuais;
--   (c) [0017] envio cuja cliente não pode mais receber → cancelado;
--   (d) [0017] conectar/desconectar;
--   (e) [0017 + novo] envios: além das regras da 0017, só com a sessão 'connected'.
create or replace function whatsapp_private.claim_outbox(p_worker_id text, p_limit int default 10, p_lock_seconds int default 60,
                                                       p_kinds text[] default null)
returns setof whatsapp_private.outbox
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := greatest(1, least(p_limit, 100));
  v_lock interval := make_interval(secs => greatest(10, least(p_lock_seconds, 600)));
  v_n int;
begin
  if p_kinds is null or 'send_text' = any (p_kinds) then
    -- (a) confirmação de agendamento que não vale mais
    update whatsapp_private.outbox o
    set status = 'canceled', last_error = 'agendamento não está mais em aberto', locked_by = null, locked_until = null,
        updated_at = now()
    from whatsapp_private.sessions s
    where o.kind = 'send_text' and o.appointment_id is not null
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
      and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
      and not exists (select 1 from appointments a
                      where a.id = o.appointment_id and a.company_id = o.company_id and a.client_id = o.client_id
                        and a.status in ('agendado', 'confirmado') and a.scheduled_start > now());

    -- (b) confirmação automática pendente: refeita com os dados de agora
    update whatsapp_private.outbox o
    set body = x.body, to_phone = x.phone, updated_at = now()
    from (
      select o2.id, whatsapp_private.confirmation_text(o2.appointment_id) as body, cl.phone_normalized as phone
      from whatsapp_private.outbox o2
      join whatsapp_private.appointment_confirmations ac on ac.outbox_id = o2.id
      join whatsapp_private.sessions s on s.company_id = o2.company_id
      join clients cl on cl.id = o2.client_id and cl.company_id = o2.company_id
      where o2.kind = 'send_text' and o2.status = 'pending'
        and s.lease_owner = p_worker_id and s.lease_until > now()
    ) x
    where o.id = x.id and x.body is not null and x.phone is not null
      and (o.body is distinct from x.body or o.to_phone is distinct from x.phone);
  end if;

  -- (c) cliente que não pode mais receber
  update whatsapp_private.outbox o
  set status = 'canceled', last_error = 'cliente não pode mais receber: ' || whatsapp_private.recipient_block(c),
      updated_at = now()
  from clients c, whatsapp_private.sessions s
  where o.kind = 'send_text' and o.status = 'pending'
    and (p_kinds is null or 'send_text' = any (p_kinds))
    and c.id = o.client_id and c.company_id = o.company_id
    and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
    and whatsapp_private.recipient_block(c) is not null;

  -- (d) conectar / desconectar
  return query
  with c as (
    select o.id from whatsapp_private.outbox o
    join whatsapp_private.sessions s on s.company_id = o.company_id
    where o.kind <> 'send_text'
      and (p_kinds is null or o.kind = any (p_kinds))
      and s.lease_owner = p_worker_id and s.lease_until > now()
      and o.available_at <= now()
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
    order by o.created_at
    limit v_limit
    for update of o skip locked
  )
  update whatsapp_private.outbox o
  set status = 'processing', locked_by = p_worker_id, locked_until = now() + v_lock,
      attempts = o.attempts + 1, updated_at = now()
  from c where o.id = c.id
  returning o.*;
  get diagnostics v_n = row_count;
  if v_n >= v_limit or (p_kinds is not null and not ('send_text' = any (p_kinds))) then
    return;
  end if;

  -- (e) envios (cliente revalidada com trava compartilhada; sessão conectada)
  return query
  with c as (
    select o.id from whatsapp_private.outbox o
    join whatsapp_private.sessions s on s.company_id = o.company_id
    join clients cl on cl.id = o.client_id and cl.company_id = o.company_id
    where o.kind = 'send_text'
      and s.lease_owner = p_worker_id and s.lease_until > now()
      and s.status = 'connected'
      and o.available_at <= now()
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
      and whatsapp_private.recipient_block(cl) is null
    order by o.created_at
    limit v_limit - v_n
    for update of o skip locked
    for share of cl
  )
  update whatsapp_private.outbox o
  set status = 'processing', locked_by = p_worker_id, locked_until = now() + v_lock,
      attempts = o.attempts + 1, updated_at = now()
  from c where o.id = c.id
  returning o.*;
end;
$$;


-- 5. RPCs DO APP ------------------------------------------------------------------
-- Situação da confirmação de UM agendamento (qualquer membro ativo da empresa).
-- Não expõe telefone, texto nem erro bruto.
--   state: none | skipped | queued | retrying | sending | sent | delivered | read | failed | canceled
create or replace function wa_get_appointment_confirmation(p_appointment_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  ac whatsapp_private.appointment_confirmations%rowtype;
  o whatsapp_private.outbox%rowtype;
  v_msg text;
  v_state text;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into a from appointments where id = p_appointment_id;
  if not found or whatsapp_private.caller_role(a.company_id) is null then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  select * into ac from whatsapp_private.appointment_confirmations where appointment_id = a.id and company_id = a.company_id;
  if not found then
    return jsonb_build_object('state', 'none');
  end if;
  if ac.status = 'skipped' then
    return jsonb_build_object('state', 'skipped', 'reason', ac.reason, 'at', ac.created_at);
  end if;
  select * into o from whatsapp_private.outbox where id = ac.outbox_id;
  if not found then
    return jsonb_build_object('state', 'none');
  end if;
  v_state := case o.status
    when 'pending' then case when o.attempts > 0 then 'retrying' else 'queued' end
    when 'processing' then 'sending'
    else o.status end;
  if o.status = 'sent' then
    select m.status into v_msg from whatsapp_private.messages m
    where m.company_id = o.company_id and m.outbox_id = o.id and m.direction = 'out'
    order by m.created_at desc limit 1;
    if v_msg in ('delivered', 'read', 'failed') then v_state := v_msg; end if;
  end if;
  return jsonb_build_object(
    'state', v_state,
    'reason', case when o.status = 'failed' and o.last_error = 'número sem WhatsApp' then 'no_whatsapp'
                   when o.status = 'canceled' and o.last_error like 'cliente não pode mais receber%' then 'recipient_blocked'
                   when o.status = 'canceled' and o.last_error like 'agendamento%' then 'appointment_changed'
                   when o.status = 'canceled' then 'canceled' end,
    'attempts', o.attempts,
    'at', o.updated_at);
end;
$$;

-- Preferência da empresa. Qualquer membro lê; só owner/admin altera.
-- available = a operação já ligou a confirmação automática neste ambiente.
-- configured = a empresa já pediu conexão do WhatsApp alguma vez.
create or replace function wa_get_auto_confirmation(p_company_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  v_pref boolean;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  select auto_confirmation into v_pref from whatsapp_private.sessions where company_id = p_company_id;
  return jsonb_build_object(
    'enabled', coalesce(v_pref, true),
    'configured', v_pref is not null,
    'available', coalesce((select auto_confirmation_enabled from whatsapp_private.settings where id), false),
    'can_manage', v_role in ('owner', 'admin'));
end;
$$;

create or replace function wa_set_auto_confirmation(p_company_id uuid, p_enabled boolean)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa altera a confirmação automática.' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'Valor inválido.' using errcode = '22023'; end if;
  -- só vale para empresa que já pediu conexão (não cria sessão por aqui)
  update whatsapp_private.sessions set auto_confirmation = p_enabled, updated_at = now()
  where company_id = p_company_id;
  if not found then
    raise exception 'Conecte o WhatsApp da empresa antes.' using errcode = '22023';
  end if;
  return jsonb_build_object('enabled', p_enabled);
end;
$$;


-- 6. PRIVILÉGIOS ------------------------------------------------------------------------
revoke all on whatsapp_private.appointment_confirmations from public;
revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz),
                       whatsapp_private.on_appointment_created() from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on whatsapp_private.appointment_confirmations from %I', r);
      execute format('revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz), whatsapp_private.on_appointment_created() from %I', r);
    end if;
  end loop;
end $$;

revoke all on function wa_get_appointment_confirmation(uuid), wa_get_auto_confirmation(uuid),
  wa_set_auto_confirmation(uuid, boolean) from public, anon;
grant execute on function wa_get_appointment_confirmation(uuid), wa_get_auto_confirmation(uuid),
  wa_set_auto_confirmation(uuid, boolean) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function wa_get_appointment_confirmation(uuid), wa_get_auto_confirmation(uuid),
      wa_set_auto_confirmation(uuid, boolean) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
