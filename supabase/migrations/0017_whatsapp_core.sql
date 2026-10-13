-- ---------------------------------------------------------------------------
-- 0017 — WhatsApp (W1): base de dados, RPCs do app e funções do worker
--
-- Uma sessão de WhatsApp por EMPRESA. O app nunca fala com o worker: tudo passa
-- pelo banco.
--
--   App (authenticated) ──RPCs públicas──> whatsapp_private <──funções do worker── wa_worker
--
-- Schema PRIVADO whatsapp_private (não exposto pela API):
--   settings     uma linha: limites (ritmo de envio, validade do QR, "sem sinal")
--   sessions     1 por empresa: status, número, trava de posse (lease), sinal de vida
--   auth         credenciais do Baileys JÁ CRIPTOGRAFADAS pelo worker (o banco só
--                guarda bytes opacos; a chave fica só no ambiente do worker)
--   qr           QR atual (vida curta), lido só por owner/admin via RPC
--   messages     mensagens recebidas e enviadas; único por (empresa, id do WhatsApp)
--   outbox       pedidos do app (conectar, desconectar, enviar), com idempotência
--   workers      batimento de cada processo worker
--
-- RPCs públicas (authenticated; SECURITY DEFINER; empresa e papel checados aqui):
--   wa_request_connection, wa_get_status, wa_get_qr, wa_disconnect   (conexão)
--   wa_send_message, wa_send_confirmation                            (envio)
--   wa_get_conversation                                              (leitura)
--
-- Regra de envio (aprovada): cliente da empresa, NÃO arquivada, com celular
-- válido (phone_normalized de 13 dígitos) e comm_status <> 'blocked'.
-- 'unknown' e 'allowed' recebem. Quem responde SAIR vira 'blocked' com origem
-- 'client_opt_out' (regra de origem já existente na 0008).
--
-- Funções do worker (schema privado; EXECUTE só para o papel wa_worker, criado
-- SEM login — login e senha são da W2). Toda ação sobre uma sessão exige a trava
-- de posse daquela empresa.
--
-- "Sem sinal" é derivado na leitura (last_seen_at antigo) — não há job agendado.
-- Não altera dados existentes, RLS/policies existentes, nem 0015/0016.
-- ---------------------------------------------------------------------------

-- 0. PREFLIGHT -----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clients' and column_name = 'comm_status_source')
     or not exists (select 1 from pg_constraint where conname = 'clients_company_id_id_key')
     or not exists (select 1 from pg_proc where proname = 'reclassify_appointment_as_no_show') then
    raise exception '0017 ABORTADA — nada foi alterado. Aplique antes as migrations até a 0014.' using errcode = '55000';
  end if;
end $$;


-- 1. SCHEMA PRIVADO E PAPEL DO WORKER ------------------------------------------------
create schema if not exists whatsapp_private;
revoke all on schema whatsapp_private from public;
alter default privileges in schema whatsapp_private revoke execute on functions from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wa_worker') then
    -- sem login: a W2 habilita login com senha gerada na hora, guardada só no worker
    create role wa_worker nologin noinherit;
  end if;
end $$;
grant usage on schema whatsapp_private to wa_worker;


-- 2. TABELAS ---------------------------------------------------------------------------
create table if not exists whatsapp_private.settings (
  id                 boolean primary key default true constraint wa_settings_singleton check (id),
  send_per_minute    int not null default 20  check (send_per_minute between 1 and 120),
  send_per_day       int not null default 300 check (send_per_day between 1 and 5000),
  qr_ttl             interval not null default interval '60 seconds',
  stale_after        interval not null default interval '2 minutes',
  max_body_chars     int not null default 4096 check (max_body_chars between 1 and 4096),
  outbox_max_attempts int not null default 5 check (outbox_max_attempts between 1 and 20)
);
insert into whatsapp_private.settings (id) values (true) on conflict (id) do nothing;

create table if not exists whatsapp_private.sessions (
  company_id    uuid primary key references companies (id) on delete cascade,
  status        text not null default 'disconnected'
                  check (status in ('disconnected', 'connect_requested', 'qr_pending', 'connecting',
                                    'connected', 'disconnect_requested', 'logged_out', 'error')),
  phone         text,
  wa_jid        text,
  connected_at  timestamptz,
  last_seen_at  timestamptz,
  lease_owner   text,
  lease_until   timestamptz,
  last_error    text,
  requested_by  uuid references auth.users (id) on delete set null,
  requested_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists whatsapp_private.auth (
  company_id  uuid not null references whatsapp_private.sessions (company_id) on delete cascade,
  category    text not null check (char_length(category) between 1 and 64),
  key_id      text not null check (char_length(key_id) between 1 and 256),
  data        bytea not null check (octet_length(data) >= 29),   -- nonce(12)+tag(16)+≥1 byte: só cifrado
  key_version int not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (company_id, category, key_id)
);

create table if not exists whatsapp_private.qr (
  company_id uuid primary key references whatsapp_private.sessions (company_id) on delete cascade,
  qr         text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists whatsapp_private.outbox (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies (id) on delete cascade,
  kind            text not null check (kind in ('connect', 'disconnect', 'send_text')),
  client_id       uuid,
  appointment_id  uuid,
  to_phone        text,
  body            text,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  status          text not null default 'pending'
                    check (status in ('pending', 'processing', 'sent', 'done', 'failed', 'canceled')),
  attempts        int not null default 0,
  max_attempts    int not null default 5,
  available_at    timestamptz not null default now(),
  locked_by       text,
  locked_until    timestamptz,
  last_error      text,
  wa_message_id   text,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint wa_outbox_idempotency unique (company_id, idempotency_key),
  constraint wa_outbox_send_fields check (kind <> 'send_text' or (client_id is not null and to_phone is not null and body is not null))
);
create index if not exists wa_outbox_pending_idx on whatsapp_private.outbox (available_at) where status in ('pending', 'processing');
create index if not exists wa_outbox_company_created_idx on whatsapp_private.outbox (company_id, created_at);

create table if not exists whatsapp_private.messages (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies (id) on delete cascade,
  direction      text not null check (direction in ('in', 'out')),
  wa_message_id  text not null,
  remote_jid     text not null,
  phone          text,
  client_id      uuid,
  body           text,
  msg_type       text not null default 'text',
  status         text not null check (status in ('received', 'sent', 'delivered', 'read', 'failed')),
  outbox_id      uuid references whatsapp_private.outbox (id) on delete set null,
  sent_by        uuid references auth.users (id) on delete set null,
  wa_timestamp   timestamptz,
  created_at     timestamptz not null default now(),
  constraint wa_messages_once unique (company_id, wa_message_id),
  constraint wa_messages_client_fk foreign key (company_id, client_id)
    references clients (company_id, id) on delete set null (client_id)
);
create index if not exists wa_messages_client_idx on whatsapp_private.messages (company_id, client_id, created_at desc);

create table if not exists whatsapp_private.workers (
  worker_id    text primary key check (char_length(worker_id) between 1 and 100),
  version      text,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table whatsapp_private.settings enable row level security;
alter table whatsapp_private.sessions enable row level security;
alter table whatsapp_private.auth enable row level security;
alter table whatsapp_private.qr enable row level security;
alter table whatsapp_private.outbox enable row level security;
alter table whatsapp_private.messages enable row level security;
alter table whatsapp_private.workers enable row level security;


-- 3. AUXILIARES (privadas) -------------------------------------------------------------
-- papel ativo do usuário logado numa empresa (null = não é membro ativo)
create or replace function whatsapp_private.caller_role(p_company_id uuid)
returns member_role
language sql stable security definer
set search_path = public, pg_temp
as $$
  select role from company_members
  where company_id = p_company_id and user_id = auth.uid() and active = true
  limit 1
$$;

-- variações de um número brasileiro: com e sem o 9º dígito do celular
create or replace function whatsapp_private.phone_variants(p_digits text)
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_digits ~ '^55[1-9][0-9]9[0-9]{8}$' then array[p_digits, substr(p_digits, 1, 4) || substr(p_digits, 6)]
    when p_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then array[p_digits, substr(p_digits, 1, 4) || '9' || substr(p_digits, 5)]
    else array[p_digits]
  end
$$;

-- motivo pelo qual a cliente NÃO pode receber (null = pode). Regra aprovada:
-- 'unknown' e 'allowed' recebem; 'blocked' (manual ou SAIR) e arquivada não.
create or replace function whatsapp_private.recipient_block(c clients)
returns text
language sql stable
set search_path = public, pg_temp
as $$
  select case
    when c.archived_at is not null then 'archived'
    when c.comm_status = 'blocked' then 'blocked'
    when c.phone_normalized is null and coalesce(btrim(c.phone), '') = '' then 'no_phone'
    when c.phone_normalized is null then 'invalid_phone'
    when char_length(c.phone_normalized) <> 13 then 'landline'
    else null
  end
$$;

-- a sessão está pronta para enviar? (conectada e com sinal recente)
create or replace function whatsapp_private.session_ready(p_company_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from whatsapp_private.sessions s, whatsapp_private.settings st
    where s.company_id = p_company_id and s.status = 'connected'
      and s.last_seen_at >= now() - st.stale_after
  )
$$;

-- enfileira um envio já validado (idempotente por chave)
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
  select count(*) filter (where created_at > now() - interval '1 minute'),
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


-- 4. RPCs DO APP: CONEXÃO ------------------------------------------------------------
create or replace function wa_get_status(p_company_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  s whatsapp_private.sessions%rowtype;
  st whatsapp_private.settings%rowtype;
  v_status text;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  select * into st from whatsapp_private.settings where id;
  select * into s from whatsapp_private.sessions where company_id = p_company_id;
  if not found then
    return jsonb_build_object('status', 'disconnected', 'can_manage', v_role in ('owner', 'admin'),
                              'can_send', false, 'qr_available', false);
  end if;
  v_status := s.status;
  if s.status in ('connected', 'connecting', 'qr_pending')
     and (s.last_seen_at is null or s.last_seen_at < now() - st.stale_after) then
    v_status := 'stale';   -- sem sinal do worker: tratar como desconectado (fallback wa.me)
  end if;
  return jsonb_build_object(
    'status', v_status,
    'phone', s.phone,
    'connected_at', s.connected_at,
    'last_seen_at', s.last_seen_at,
    'last_error', case when v_role in ('owner', 'admin') then s.last_error end,
    'can_manage', v_role in ('owner', 'admin'),
    'can_send', v_status = 'connected' and v_role in ('owner', 'admin', 'professional'),
    'qr_available', v_role in ('owner', 'admin')
                    and exists (select 1 from whatsapp_private.qr q where q.company_id = p_company_id and q.expires_at > now()));
end;
$$;

create or replace function wa_request_connection(p_company_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  s whatsapp_private.sessions%rowtype;
  v_pending uuid;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa conecta o WhatsApp.' using errcode = '42501';
  end if;

  insert into whatsapp_private.sessions (company_id) values (p_company_id) on conflict (company_id) do nothing;
  select * into s from whatsapp_private.sessions where company_id = p_company_id for update;
  if s.status = 'connected' then
    return jsonb_build_object('status', 'connected', 'created', false);
  end if;

  select id into v_pending from whatsapp_private.outbox
  where company_id = p_company_id and kind = 'connect' and status in ('pending', 'processing')
  limit 1;
  if v_pending is null then
    insert into whatsapp_private.outbox (company_id, kind, idempotency_key, created_by)
    values (p_company_id, 'connect', 'connect:' || gen_random_uuid(), auth.uid())
    returning id into v_pending;
  end if;

  update whatsapp_private.sessions
  set status = case when status in ('qr_pending', 'connecting') then status else 'connect_requested' end,
      requested_by = auth.uid(), requested_at = now(), last_error = null, updated_at = now()
  where company_id = p_company_id;
  return jsonb_build_object('status', 'connect_requested', 'outbox_id', v_pending, 'created', true);
end;
$$;

create or replace function wa_get_qr(p_company_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  q whatsapp_private.qr%rowtype;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa vê o QR de conexão.' using errcode = '42501';
  end if;
  select * into q from whatsapp_private.qr where company_id = p_company_id and expires_at > now();
  if not found then
    return jsonb_build_object('qr', null);
  end if;
  return jsonb_build_object('qr', q.qr, 'expires_at', q.expires_at);
end;
$$;

create or replace function wa_disconnect(p_company_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  s whatsapp_private.sessions%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa desconecta o WhatsApp.' using errcode = '42501';
  end if;
  select * into s from whatsapp_private.sessions where company_id = p_company_id for update;
  if not found or s.status in ('disconnected', 'logged_out') then
    return jsonb_build_object('status', coalesce(s.status, 'disconnected'), 'created', false);
  end if;
  select id into v_id from whatsapp_private.outbox
  where company_id = p_company_id and kind = 'disconnect' and status in ('pending', 'processing') limit 1;
  if v_id is null then
    insert into whatsapp_private.outbox (company_id, kind, idempotency_key, created_by)
    values (p_company_id, 'disconnect', 'disconnect:' || gen_random_uuid(), auth.uid())
    returning id into v_id;
  end if;
  -- pedidos de conexão pendentes deixam de valer
  update whatsapp_private.outbox set status = 'canceled', updated_at = now()
  where company_id = p_company_id and kind = 'connect' and status = 'pending';
  update whatsapp_private.sessions set status = 'disconnect_requested', updated_at = now()
  where company_id = p_company_id;
  return jsonb_build_object('status', 'disconnect_requested', 'outbox_id', v_id, 'created', true);
end;
$$;


-- 5. RPCs DO APP: ENVIO E LEITURA -----------------------------------------------------
-- AUW01 = WhatsApp não conectado (a tela usa o wa.me); AUW02 = cliente não pode
-- receber (detalhe = motivo); AUW03 = limite; AUW04 = chave reaproveitada; AUW05 = texto inválido.
create or replace function wa_send_message(p_client_id uuid, p_body text, p_idempotency_key text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  c clients%rowtype;
  v_role member_role;
  v_block text;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into c from clients where id = p_client_id;
  if not found or whatsapp_private.caller_role(c.company_id) is null then
    raise exception 'Cliente não encontrada.' using errcode = 'P0002';
  end if;
  v_role := whatsapp_private.caller_role(c.company_id);
  if v_role not in ('owner', 'admin', 'professional') then
    raise exception 'Seu papel não permite enviar mensagens.' using errcode = '42501';
  end if;
  if v_body = '' or char_length(v_body) > (select max_body_chars from whatsapp_private.settings where id) then
    raise exception 'Mensagem vazia ou longa demais.' using errcode = 'AUW05';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Chave de envio ausente.' using errcode = 'AUW05';
  end if;
  v_block := whatsapp_private.recipient_block(c);
  if v_block is not null then
    raise exception 'Esta cliente não pode receber mensagens (%).', v_block using errcode = 'AUW02', detail = v_block;
  end if;
  if not whatsapp_private.session_ready(c.company_id) then
    raise exception 'O WhatsApp da empresa não está conectado.' using errcode = 'AUW01';
  end if;
  return whatsapp_private.enqueue_send(c.company_id, c.id, null, c.phone_normalized, v_body, btrim(p_idempotency_key));
end;
$$;

-- Confirmação de agendamento: o texto vem da tela (buildConfirmationMessage);
-- o banco confere atendimento, cliente e papel. Chave padrão: atendimento + texto.
create or replace function wa_send_confirmation(p_appointment_id uuid, p_body text, p_idempotency_key text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  c clients%rowtype;
  v_role member_role;
  v_block text;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into a from appointments where id = p_appointment_id;
  if not found or whatsapp_private.caller_role(a.company_id) is null then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  v_role := whatsapp_private.caller_role(a.company_id);
  if v_role not in ('owner', 'admin', 'professional') then
    raise exception 'Seu papel não permite enviar mensagens.' using errcode = '42501';
  end if;
  if a.status not in ('agendado', 'confirmado') or a.scheduled_start <= now() then
    raise exception 'Só dá para confirmar um agendamento futuro em aberto.' using errcode = '22023';
  end if;
  if v_body = '' or char_length(v_body) > (select max_body_chars from whatsapp_private.settings where id) then
    raise exception 'Mensagem vazia ou longa demais.' using errcode = 'AUW05';
  end if;
  select * into c from clients where id = a.client_id;
  v_block := whatsapp_private.recipient_block(c);
  if v_block is not null then
    raise exception 'Esta cliente não pode receber mensagens (%).', v_block using errcode = 'AUW02', detail = v_block;
  end if;
  if not whatsapp_private.session_ready(a.company_id) then
    raise exception 'O WhatsApp da empresa não está conectado.' using errcode = 'AUW01';
  end if;
  return whatsapp_private.enqueue_send(
    a.company_id, c.id, a.id, c.phone_normalized, v_body,
    coalesce(nullif(btrim(p_idempotency_key), ''), 'confirmation:' || a.id || ':' || md5(v_body)));
end;
$$;

create or replace function wa_get_conversation(p_client_id uuid, p_limit int default 50)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  c clients%rowtype;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into c from clients where id = p_client_id;
  if not found or whatsapp_private.caller_role(c.company_id) is null then
    raise exception 'Cliente não encontrada.' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'can_receive', whatsapp_private.recipient_block(c) is null,
    'block_reason', whatsapp_private.recipient_block(c),
    'items', coalesce((
      select jsonb_agg(x order by x.at desc) from (
        select m.id, 'message' as kind, m.direction, m.body, m.status, coalesce(m.wa_timestamp, m.created_at) as at
        from whatsapp_private.messages m
        where m.company_id = c.company_id and m.client_id = c.id
        union all
        select o.id, 'pending', 'out', o.body, o.status, o.created_at
        from whatsapp_private.outbox o
        where o.company_id = c.company_id and o.client_id = c.id and o.kind = 'send_text'
          and o.status in ('pending', 'processing', 'failed')
        order by at desc
        limit greatest(1, least(coalesce(p_limit, 50), 200))
      ) x), '[]'::jsonb));
end;
$$;


-- 6. FUNÇÕES DO WORKER (só wa_worker executa; trava de posse obrigatória) ----------
create or replace function whatsapp_private.assert_lease(p_company_id uuid, p_worker_id text)
returns void
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from whatsapp_private.sessions
                  where company_id = p_company_id and lease_owner = p_worker_id and lease_until > now()) then
    raise exception 'Este worker não detém a sessão desta empresa.' using errcode = 'AUW10';
  end if;
end;
$$;

create or replace function whatsapp_private.worker_heartbeat(p_worker_id text, p_version text default null)
returns void
language sql security definer
set search_path = public, pg_temp
as $$
  insert into whatsapp_private.workers (worker_id, version) values (p_worker_id, p_version)
  on conflict (worker_id) do update set last_seen_at = now(), version = coalesce(excluded.version, whatsapp_private.workers.version)
$$;

-- pega ou renova a posse da sessão (renovar também é o "sinal de vida" da sessão)
create or replace function whatsapp_private.acquire_lease(p_company_id uuid, p_worker_id text, p_ttl_seconds int default 60)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  update whatsapp_private.sessions
  set lease_owner = p_worker_id,
      lease_until = now() + make_interval(secs => greatest(10, least(p_ttl_seconds, 300))),
      last_seen_at = now(), updated_at = now()
  where company_id = p_company_id
    and (lease_owner is null or lease_owner = p_worker_id or lease_until is null or lease_until <= now())
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function whatsapp_private.release_lease(p_company_id uuid, p_worker_id text)
returns void
language sql security definer
set search_path = public, pg_temp
as $$
  update whatsapp_private.sessions set lease_owner = null, lease_until = null, updated_at = now()
  where company_id = p_company_id and lease_owner = p_worker_id
$$;

-- sessões que um worker deve manter/abrir ao iniciar
create or replace function whatsapp_private.sessions_to_run()
returns table (company_id uuid, status text, has_auth boolean, lease_owner text, lease_until timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select s.company_id, s.status,
         exists (select 1 from whatsapp_private.auth a where a.company_id = s.company_id),
         s.lease_owner, s.lease_until
  from whatsapp_private.sessions s
  where s.status in ('connect_requested', 'qr_pending', 'connecting', 'connected', 'disconnect_requested')
$$;

create or replace function whatsapp_private.set_session_state(
  p_company_id uuid, p_worker_id text, p_status text,
  p_phone text default null, p_jid text default null, p_error text default null)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform whatsapp_private.assert_lease(p_company_id, p_worker_id);
  if p_status not in ('qr_pending', 'connecting', 'connected', 'disconnected', 'logged_out', 'error') then
    raise exception 'Status inválido: %', p_status using errcode = '22023';
  end if;
  update whatsapp_private.sessions
  set status = p_status,
      phone = case when p_status = 'connected' then coalesce(p_phone, phone) when p_status in ('logged_out', 'disconnected') then null else phone end,
      wa_jid = case when p_status = 'connected' then coalesce(p_jid, wa_jid) when p_status in ('logged_out', 'disconnected') then null else wa_jid end,
      connected_at = case when p_status = 'connected' then now() else connected_at end,
      last_error = case when p_status = 'error' then left(p_error, 500) else null end,
      last_seen_at = now(), updated_at = now()
  where company_id = p_company_id;
  if p_status in ('connected', 'logged_out', 'disconnected') then
    delete from whatsapp_private.qr where company_id = p_company_id;
  end if;
  if p_status in ('logged_out', 'disconnected') then
    -- desconectado (pelo celular ou pelo app): credenciais não servem mais; precisa novo QR
    delete from whatsapp_private.auth where company_id = p_company_id;
  end if;
end;
$$;

create or replace function whatsapp_private.put_qr(p_company_id uuid, p_worker_id text, p_qr text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform whatsapp_private.assert_lease(p_company_id, p_worker_id);
  if p_qr is null or char_length(p_qr) not between 10 and 2000 then
    raise exception 'QR inválido.' using errcode = '22023';
  end if;
  insert into whatsapp_private.qr (company_id, qr, expires_at)
  values (p_company_id, p_qr, now() + (select qr_ttl from whatsapp_private.settings where id))
  on conflict (company_id) do update set qr = excluded.qr, created_at = now(), expires_at = excluded.expires_at;
  update whatsapp_private.sessions set status = 'qr_pending', last_seen_at = now(), updated_at = now()
  where company_id = p_company_id;
end;
$$;

-- credenciais: o banco só guarda bytes opacos (cifrados no worker)
create or replace function whatsapp_private.auth_read(p_company_id uuid, p_worker_id text, p_category text, p_key_ids text[])
returns table (key_id text, data bytea, key_version int)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform whatsapp_private.assert_lease(p_company_id, p_worker_id);
  return query
    select a.key_id, a.data, a.key_version from whatsapp_private.auth a
    where a.company_id = p_company_id and a.category = p_category and a.key_id = any (p_key_ids);
end;
$$;

-- p_items: [{"category":..., "key_id":..., "data": base64 | null (null = apagar), "key_version": n}]
create or replace function whatsapp_private.auth_write(p_company_id uuid, p_worker_id text, p_items jsonb)
returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  it jsonb;
  n int := 0;
begin
  perform whatsapp_private.assert_lease(p_company_id, p_worker_id);
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if it->>'data' is null then
      delete from whatsapp_private.auth
      where company_id = p_company_id and category = it->>'category' and key_id = it->>'key_id';
    else
      insert into whatsapp_private.auth (company_id, category, key_id, data, key_version)
      values (p_company_id, it->>'category', it->>'key_id', decode(it->>'data', 'base64'),
              coalesce((it->>'key_version')::int, 1))
      on conflict (company_id, category, key_id) do update
        set data = excluded.data, key_version = excluded.key_version, updated_at = now();
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- fila: pega até p_limit pedidos das empresas cuja sessão este worker detém.
-- Envios: a cliente é revalidada NA HORA de pegar, com trava compartilhada na
-- linha da cliente. Se ela estiver mudando (ex.: acabou de responder SAIR), a
-- fila espera essa gravação terminar e reavalia com o dado novo. Envios cuja
-- cliente já não pode receber são cancelados. p_kinds (opcional) limita os tipos
-- pegos: a W2 pega só 'connect'/'disconnect'; envios ficam para a W5.
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
  update whatsapp_private.outbox o
  set status = 'canceled', last_error = 'cliente não pode mais receber: ' || whatsapp_private.recipient_block(c),
      updated_at = now()
  from clients c, whatsapp_private.sessions s
  where o.kind = 'send_text' and o.status = 'pending'
    and (p_kinds is null or 'send_text' = any (p_kinds))
    and c.id = o.client_id and c.company_id = o.company_id
    and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
    and whatsapp_private.recipient_block(c) is not null;

  -- conectar / desconectar
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

  -- envios (cliente revalidada com trava compartilhada)
  return query
  with c as (
    select o.id from whatsapp_private.outbox o
    join whatsapp_private.sessions s on s.company_id = o.company_id
    join clients cl on cl.id = o.client_id and cl.company_id = o.company_id
    where o.kind = 'send_text'
      and s.lease_owner = p_worker_id and s.lease_until > now()
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

-- conclusão de um pedido; para send_text grava a mensagem enviada (sem duplicar)
create or replace function whatsapp_private.complete_outbox(p_outbox_id uuid, p_worker_id text, p_wa_message_id text default null)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  o whatsapp_private.outbox%rowtype;
begin
  select * into o from whatsapp_private.outbox where id = p_outbox_id for update;
  if not found then raise exception 'Pedido não encontrado.' using errcode = 'P0002'; end if;
  if o.status in ('sent', 'done') then
    return false;   -- repetição inofensiva
  end if;
  if o.status <> 'processing' or o.locked_by is distinct from p_worker_id then
    raise exception 'Este pedido não está com este worker.' using errcode = 'AUW11';
  end if;
  if o.kind = 'send_text' then
    if p_wa_message_id is null then
      raise exception 'Envio sem id do WhatsApp.' using errcode = '22023';
    end if;
    insert into whatsapp_private.messages (company_id, direction, wa_message_id, remote_jid, phone, client_id,
                                           body, status, outbox_id, sent_by, wa_timestamp)
    values (o.company_id, 'out', p_wa_message_id, o.to_phone || '@s.whatsapp.net', o.to_phone, o.client_id,
            o.body, 'sent', o.id, o.created_by, now())
    on conflict (company_id, wa_message_id) do nothing;
  end if;
  update whatsapp_private.outbox
  set status = case when o.kind = 'send_text' then 'sent' else 'done' end,
      wa_message_id = p_wa_message_id, locked_by = null, locked_until = null, last_error = null, updated_at = now()
  where id = p_outbox_id;
  return true;
end;
$$;

create or replace function whatsapp_private.fail_outbox(p_outbox_id uuid, p_worker_id text, p_error text, p_retryable boolean default true)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  o whatsapp_private.outbox%rowtype;
  v_status text;
begin
  select * into o from whatsapp_private.outbox where id = p_outbox_id for update;
  if not found then raise exception 'Pedido não encontrado.' using errcode = 'P0002'; end if;
  if o.status <> 'processing' or o.locked_by is distinct from p_worker_id then
    raise exception 'Este pedido não está com este worker.' using errcode = 'AUW11';
  end if;
  v_status := case when p_retryable and o.attempts < o.max_attempts then 'pending' else 'failed' end;
  update whatsapp_private.outbox
  set status = v_status, last_error = left(p_error, 500), locked_by = null, locked_until = null,
      available_at = case when v_status = 'pending'
                          then now() + make_interval(secs => least(3600, 10 * power(2, o.attempts)::int))
                          else available_at end,
      updated_at = now()
  where id = p_outbox_id;
  return v_status;
end;
$$;

-- mensagem recebida: grava uma única vez, liga à cliente pelo telefone (com e sem
-- o 9º dígito) e trata SAIR/PARAR/STOP como pedido de saída.
create or replace function whatsapp_private.record_inbound(
  p_company_id uuid, p_worker_id text, p_wa_message_id text, p_remote_jid text,
  p_body text, p_wa_timestamp timestamptz default null, p_msg_type text default 'text')
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_digits text;
  v_client uuid;
  v_inserted boolean := false;
  v_opt_out boolean := false;
  v_word text;
begin
  perform whatsapp_private.assert_lease(p_company_id, p_worker_id);
  if p_remote_jid ~ '@(g\.us|broadcast|newsletter)$' then
    return jsonb_build_object('ignored', true, 'reason', 'not_a_contact');   -- grupos, status, listas, canais
  end if;
  if p_remote_jid ~ '@s\.whatsapp\.net$' then
    v_digits := split_part(split_part(p_remote_jid, '@', 1), ':', 1);
    select c.id into v_client from clients c
    where c.company_id = p_company_id and c.phone_normalized = any (whatsapp_private.phone_variants(v_digits))
    order by (c.archived_at is null) desc, c.created_at
    limit 1;
  end if;
  -- outros identificadores (ex.: @lid, sem telefone): a mensagem fica registrada,
  -- sem vínculo com cliente; o worker (W4) deve preferir o identificador com número.

  insert into whatsapp_private.messages (company_id, direction, wa_message_id, remote_jid, phone, client_id,
                                         body, msg_type, status, wa_timestamp)
  values (p_company_id, 'in', p_wa_message_id, p_remote_jid, v_digits, v_client,
          left(p_body, 4096), coalesce(p_msg_type, 'text'), 'received', p_wa_timestamp)
  on conflict (company_id, wa_message_id) do nothing
  returning true into v_inserted;
  v_inserted := coalesce(v_inserted, false);

  v_word := upper(regexp_replace(btrim(coalesce(p_body, '')), '[[:punct:][:space:]]+$', ''));
  if v_inserted and v_digits is not null and v_word in ('SAIR', 'PARAR', 'STOP') then
    -- sem usuário logado: a regra da 0008 preserva a origem 'client_opt_out'
    update clients
    set comm_status = 'blocked', comm_status_source = 'client_opt_out'
    where company_id = p_company_id
      and phone_normalized = any (whatsapp_private.phone_variants(v_digits))
      and comm_status <> 'blocked';
    v_opt_out := true;
  end if;
  return jsonb_build_object('inserted', v_inserted, 'client_id', v_client, 'opted_out', v_opt_out);
end;
$$;

-- confirmação de entrega/leitura de mensagem enviada (só avança: sent < delivered < read)
create or replace function whatsapp_private.record_message_status(
  p_company_id uuid, p_worker_id text, p_wa_message_id text, p_status text)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  perform whatsapp_private.assert_lease(p_company_id, p_worker_id);
  if p_status not in ('delivered', 'read', 'failed') then
    raise exception 'Status inválido: %', p_status using errcode = '22023';
  end if;
  update whatsapp_private.messages
  set status = p_status
  where company_id = p_company_id and wa_message_id = p_wa_message_id and direction = 'out'
    and (p_status = 'failed' and status = 'sent'
         or array_position(array['sent', 'delivered', 'read'], p_status) > array_position(array['sent', 'delivered', 'read'], status));
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;


-- 7. PRIVILÉGIOS ------------------------------------------------------------------------
-- tudo do schema privado: ninguém por padrão
revoke all on all tables in schema whatsapp_private from public;
revoke all on all sequences in schema whatsapp_private from public;
revoke all on all functions in schema whatsapp_private from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema whatsapp_private from %I', r);
      execute format('revoke all on all tables in schema whatsapp_private from %I', r);
      execute format('revoke all on all sequences in schema whatsapp_private from %I', r);
      execute format('revoke all on all functions in schema whatsapp_private from %I', r);
    end if;
  end loop;
end $$;
revoke all on all tables in schema whatsapp_private from wa_worker;

-- o worker só executa as funções do worker (nenhum acesso direto a tabelas)
grant execute on function
  whatsapp_private.worker_heartbeat(text, text),
  whatsapp_private.acquire_lease(uuid, text, int),
  whatsapp_private.release_lease(uuid, text),
  whatsapp_private.sessions_to_run(),
  whatsapp_private.set_session_state(uuid, text, text, text, text, text),
  whatsapp_private.put_qr(uuid, text, text),
  whatsapp_private.auth_read(uuid, text, text, text[]),
  whatsapp_private.auth_write(uuid, text, jsonb),
  whatsapp_private.claim_outbox(text, int, int, text[]),
  whatsapp_private.complete_outbox(uuid, text, text),
  whatsapp_private.fail_outbox(uuid, text, text, boolean),
  whatsapp_private.record_inbound(uuid, text, text, text, text, timestamptz, text),
  whatsapp_private.record_message_status(uuid, text, text, text)
to wa_worker;

-- RPCs do app: só authenticated
revoke all on function wa_get_status(uuid), wa_request_connection(uuid), wa_get_qr(uuid), wa_disconnect(uuid),
  wa_send_message(uuid, text, text), wa_send_confirmation(uuid, text, text), wa_get_conversation(uuid, int)
  from public, anon;
grant execute on function wa_get_status(uuid), wa_request_connection(uuid), wa_get_qr(uuid), wa_disconnect(uuid),
  wa_send_message(uuid, text, text), wa_send_confirmation(uuid, text, text), wa_get_conversation(uuid, int)
  to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function wa_get_status(uuid), wa_request_connection(uuid), wa_get_qr(uuid), wa_disconnect(uuid),
      wa_send_message(uuid, text, text), wa_send_confirmation(uuid, text, text), wa_get_conversation(uuid, int)
      from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
