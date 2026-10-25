-- ---------------------------------------------------------------------------
-- 0045 — Assinatura de cliente nova: e-mail antes do pagamento e assinaturas "sem dona".
--
-- Incidente de 25/10/2026 (continuação da 0043/0044): o link de plano do Mercado Pago não
-- dispara o webhook e devolve payer_email vazio. A mp-sync só achava a dona testando o
-- e-mail de contas que JÁ existiam; uma cliente nova pagaria e ficaria sem acesso.
--
--   1. signup_intents: o site pede o e-mail ANTES de abrir o checkout (Edge Function
--      `signup-intent`). Esses e-mails passam a ser candidatos da mp-sync.
--   2. mp_unlinked: toda assinatura que a mp-sync não consegue ligar a um e-mail fica
--      registrada. O painel mostra a lista e permite ligar a um e-mail (auditado);
--      a mp-sync usa esse e-mail no ciclo seguinte e libera o acesso.
--   3. Alerta: a billing-emails avisa o suporte (kind 'unlinked_alert') quando uma
--      assinatura fica mais de 10 minutos sem dona.
-- Nenhum dado é apagado.
-- ---------------------------------------------------------------------------

-- 1. E-mail informado antes do checkout --------------------------------------------------
create table if not exists signup_intents (
  email      text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  utm        jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table signup_intents enable row level security;
revoke all on signup_intents from public, anon, authenticated;

-- Chamada pela Edge Function signup-intent (service_role). Limite global anti-abuso:
-- 300 novos e-mails por hora (a mp-sync consulta o Mercado Pago para cada candidato).
create or replace function signup_intent_register(p_email text, p_utm jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'E-mail inválido.' using errcode = '22023';
  end if;
  if not exists (select 1 from signup_intents where email = v_email)
     and (select count(*) from signup_intents where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'Muitos cadastros agora. Tente de novo em alguns minutos.' using errcode = 'P0001';
  end if;
  insert into signup_intents (email, utm) values (v_email, coalesce(p_utm, '{}'::jsonb) - 'email')
  on conflict (email) do update set utm = excluded.utm, updated_at = now();
  return true;
end;
$$;

-- Candidatas da mp-sync: contas sem acesso (como na 0044) + e-mails informados no site
-- nos últimos 14 dias que ainda não têm acesso por assinatura.
create or replace function mp_sync_candidates()
returns setof text language sql stable security definer set search_path = public, pg_temp as $$
  select email from (
    select lower(u.email) as email, u.created_at as at
    from auth.users u
    left join billing_accounts b on b.email = lower(u.email)
    where u.email is not null
      and u.created_at > now() - interval '90 days'
      and (b.email is null or b.status not in ('free', 'trialing', 'active', 'past_due'))
    union
    select s.email, s.updated_at
    from signup_intents s
    left join billing_accounts b on b.email = s.email
    where s.updated_at > now() - interval '14 days'
      and (b.email is null or b.status not in ('free', 'trialing', 'active', 'past_due'))
  ) c
  group by email
  order by max(at) desc
  limit 100;
$$;

-- 2. Assinaturas que a mp-sync não conseguiu ligar a um e-mail ------------------------------
create table if not exists mp_unlinked (
  preapproval_id text primary key,
  mp_status      text,
  amount         numeric(12,2),
  date_created   timestamptz,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  linked_email   text check (linked_email is null or (linked_email = lower(linked_email) and linked_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  linked_by      uuid,
  linked_at      timestamptz,
  resolved_at    timestamptz
);
alter table mp_unlinked enable row level security;
revoke all on mp_unlinked from public, anon, authenticated;

create or replace function mp_unlinked_report(p jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into mp_unlinked (preapproval_id, mp_status, amount, date_created)
  values (p ->> 'preapproval_id', p ->> 'mp_status', nullif(p ->> 'amount', '')::numeric, nullif(p ->> 'date_created', '')::timestamptz)
  on conflict (preapproval_id) do update
    set mp_status = excluded.mp_status, amount = coalesce(excluded.amount, mp_unlinked.amount),
        last_seen = now(), resolved_at = null;
$$;

create or replace function mp_unlinked_resolved(p_id text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update mp_unlinked set resolved_at = now() where preapproval_id = p_id and resolved_at is null;
$$;

-- E-mails ligados pelo painel e ainda não processados (a mp-sync usa como e-mail da assinatura).
create or replace function mp_manual_links()
returns table (preapproval_id text, email text)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.preapproval_id, u.linked_email from mp_unlinked u where u.linked_email is not null and u.resolved_at is null;
$$;

-- Painel (superadmin + MFA) ----------------------------------------------------------------
create or replace function admin_list_unlinked()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform admin_assert();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'preapproval_id', preapproval_id, 'mp_status', mp_status, 'amount', amount, 'date_created', date_created,
      'first_seen', first_seen, 'linked_email', linked_email, 'linked_at', linked_at) order by first_seen desc)
    from mp_unlinked where resolved_at is null), '[]'::jsonb);
end;
$$;

create or replace function admin_link_subscription(p_preapproval_id text, p_email text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  r mp_unlinked;
begin
  perform admin_assert();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'Informe o motivo (de 5 a 500 caracteres).' using errcode = '22023';
  end if;
  select * into r from mp_unlinked where preapproval_id = p_preapproval_id and resolved_at is null;
  if not found then raise exception 'Assinatura não encontrada ou já resolvida.' using errcode = 'P0002'; end if;
  update mp_unlinked set linked_email = v_email, linked_by = auth.uid(), linked_at = now() where preapproval_id = p_preapproval_id;
  perform admin_log('link_subscription', null, 'requested', v_reason,
                    jsonb_build_object('preapproval_id', p_preapproval_id, 'email', v_email, 'previous_email', r.linked_email));
  return jsonb_build_object('ok', true);
end;
$$;

-- 3. Alerta ao suporte (billing-emails) -----------------------------------------------------
alter table billing_emails drop constraint if exists billing_emails_kind_check;
alter table billing_emails add constraint billing_emails_kind_check check (kind in ('welcome', 'trial_ending', 'unlinked_alert'));

create or replace function billing_email_claim(p_kind text, p_preapproval_id text, p_email text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  if p_kind not in ('welcome', 'trial_ending', 'unlinked_alert') or coalesce(p_preapproval_id, '') = '' or coalesce(p_email, '') !~ '@' then
    raise exception 'Envio inválido.' using errcode = '22023';
  end if;
  insert into billing_emails (kind, preapproval_id, email) values (p_kind, p_preapproval_id, lower(p_email))
  on conflict (kind, preapproval_id) do update
    set status = 'sending', attempts = billing_emails.attempts + 1, error = null, updated_at = now(), email = excluded.email
    where billing_emails.attempts < 5
      and (billing_emails.status = 'error'
           or (billing_emails.status = 'sending' and billing_emails.updated_at < now() - interval '30 minutes'))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function billing_email_targets(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'welcome', coalesce((
      select jsonb_agg(jsonb_build_object('preapproval_id', b.preapproval_id, 'email', b.email,
                                          'status', b.status, 'next_payment_at', b.next_payment_at,
                                          'amount', b.plan_amount) order by b.updated_at)
      from billing_accounts b
      where b.provider = 'mercadopago' and b.preapproval_id is not null
        and b.status in ('trialing', 'active')
        and coalesce(b.started_at, b.updated_at) > p_now - interval '7 days'
        and not exists (select 1 from billing_emails e where e.kind = 'welcome' and e.preapproval_id = b.preapproval_id
                          and (e.status = 'sent' or e.attempts >= 5
                               or (e.status = 'sending' and e.updated_at > p_now - interval '30 minutes')))), '[]'::jsonb),
    'trial_ending', coalesce((
      select jsonb_agg(jsonb_build_object('preapproval_id', b.preapproval_id, 'email', b.email,
                                          'next_payment_at', b.next_payment_at, 'amount', b.plan_amount) order by b.next_payment_at)
      from billing_accounts b
      where b.provider = 'mercadopago' and b.preapproval_id is not null and b.status = 'trialing'
        and b.next_payment_at > p_now + interval '12 hours' and b.next_payment_at <= p_now + interval '52 hours'
        and extract(hour from p_now at time zone 'America/Sao_Paulo') between 9 and 19
        and not exists (select 1 from billing_emails e where e.kind = 'trial_ending' and e.preapproval_id = b.preapproval_id
                          and (e.status = 'sent' or e.attempts >= 5
                               or (e.status = 'sending' and e.updated_at > p_now - interval '30 minutes')))), '[]'::jsonb),
    'unlinked_alert', coalesce((
      select jsonb_agg(jsonb_build_object('preapproval_id', u.preapproval_id, 'mp_status', u.mp_status, 'amount', u.amount,
                                          'date_created', u.date_created, 'first_seen', u.first_seen) order by u.first_seen)
      from mp_unlinked u
      where u.resolved_at is null and u.linked_email is null and u.first_seen < p_now - interval '10 minutes'
        and not exists (select 1 from billing_emails e where e.kind = 'unlinked_alert' and e.preapproval_id = u.preapproval_id
                          and (e.status = 'sent' or e.attempts >= 5
                               or (e.status = 'sending' and e.updated_at > p_now - interval '30 minutes')))), '[]'::jsonb)
  );
$$;

-- Permissões ---------------------------------------------------------------------------------
revoke all on function signup_intent_register(text, jsonb) from public, anon, authenticated;
revoke all on function mp_sync_candidates() from public, anon, authenticated;
revoke all on function mp_unlinked_report(jsonb) from public, anon, authenticated;
revoke all on function mp_unlinked_resolved(text) from public, anon, authenticated;
revoke all on function mp_manual_links() from public, anon, authenticated;
revoke all on function billing_email_claim(text, text, text) from public, anon, authenticated;
revoke all on function billing_email_targets(timestamptz) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function signup_intent_register(text, jsonb) to service_role;
    grant execute on function mp_sync_candidates() to service_role;
    grant execute on function mp_unlinked_report(jsonb) to service_role;
    grant execute on function mp_unlinked_resolved(text) to service_role;
    grant execute on function mp_manual_links() to service_role;
    grant execute on function billing_email_claim(text, text, text) to service_role;
    grant execute on function billing_email_targets(timestamptz) to service_role;
  end if;
end $$;
revoke all on function admin_list_unlinked() from public, anon;
revoke all on function admin_link_subscription(text, text, text) from public, anon;
grant execute on function admin_list_unlinked() to authenticated;
grant execute on function admin_link_subscription(text, text, text) to authenticated;

notify pgrst, 'reload schema';
