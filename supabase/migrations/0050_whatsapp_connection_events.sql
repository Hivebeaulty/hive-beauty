-- ---------------------------------------------------------------------------
-- 0050 — WhatsApp: histórico de quedas e motivo da desconexão.
--
-- Até aqui o banco só guardava o estado ATUAL da sessão: quando a conexão de uma profissional caía, não
-- ficava registrado o código do WhatsApp (401? 500? 428?), e o motivo só existia nos logs da Discloud.
-- Agora o worker 0.4.1 grava cada abertura e cada queda (com o código) e, quando o WhatsApp remove o
-- aparelho (401), o motivo fica em sessions.last_error. Assim dá para ver por que uma conta cai.
--
--   whatsapp_private.connection_events : uma linha por abertura/queda (30 dias por empresa).
--   record_connection_event            : só o worker (wa_worker), e só quem detém a posse da sessão.
--   set_session_state                  : igual ao anterior, exceto que 'logged_out' também guarda o motivo.
-- Idempotente; nenhum dado existente é alterado.
--
-- Consulta de diagnóstico:
--   select at at time zone 'America/Sao_Paulo' as quando, event, code, kind, attempt
--   from whatsapp_private.connection_events where company_id = '<empresa>' order by at desc limit 50;
-- ---------------------------------------------------------------------------

create table if not exists whatsapp_private.connection_events (
  id         bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  at         timestamptz not null default now(),
  event      text not null check (event in ('open', 'close')),
  code       integer,
  kind       text,
  attempt    integer
);
create index if not exists connection_events_company_at_idx on whatsapp_private.connection_events (company_id, at desc);
alter table whatsapp_private.connection_events enable row level security;
revoke all on whatsapp_private.connection_events from public, anon, authenticated;

create or replace function whatsapp_private.record_connection_event(
  p_company_id uuid, p_worker_id text, p_event text, p_code integer, p_kind text, p_attempt integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform whatsapp_private.assert_lease(p_company_id, p_worker_id);
  if p_event not in ('open', 'close') then raise exception 'Evento inválido: %', p_event using errcode = '22023'; end if;
  insert into whatsapp_private.connection_events (company_id, event, code, kind, attempt)
  values (p_company_id, p_event, p_code, left(p_kind, 30), p_attempt);
  -- guarda 30 dias por empresa
  delete from whatsapp_private.connection_events where company_id = p_company_id and at < now() - interval '30 days';
end;
$$;

revoke all on function whatsapp_private.record_connection_event(uuid, text, text, integer, text, integer) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'wa_worker') then
    grant execute on function whatsapp_private.record_connection_event(uuid, text, text, integer, text, integer) to wa_worker;
  end if;
end $$;

-- Mesmo corpo da versão anterior; a única mudança é 'logged_out' guardar o motivo em last_error.
create or replace function whatsapp_private.set_session_state(
  p_company_id uuid, p_worker_id text, p_status text, p_phone text default null, p_jid text default null, p_error text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
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
      last_error = case when p_status in ('error', 'logged_out') then left(p_error, 500) else null end,
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
