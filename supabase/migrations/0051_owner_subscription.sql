-- ---------------------------------------------------------------------------
-- 0051 — ASSINATURA NO APP: a dona vê e cancela a própria assinatura
--   * my_subscription(empresa): situação, teste, próxima cobrança, valor e
--     histórico de cobranças da assinatura da DONA que está logada. Equipe não vê.
--     Taxas e líquido do Mercado Pago (dados internos da Sócia) não saem daqui.
--   * owner_cancel_prepare / owner_cancel_finish: o pedido de cancelamento feito
--     pela dona no app. Registra quem pediu, o motivo (opcional) e o resultado em
--     billing_owner_requests. Quem fala com o Mercado Pago é a função
--     account-billing (o token nunca vai ao navegador).
--   * billing_sync aceita a origem 'owner' (antes, origem desconhecida virava
--     'webhook'): o histórico do painel mostra que foi a dona que cancelou.
-- Não muda get_company_access: depois de cancelar, o acesso já continua até o fim
-- do mês pago (status "ending", 0041). No teste grátis, termina quando o Mercado
-- Pago confirma. Nenhum dado é apagado.
-- ---------------------------------------------------------------------------

-- 1. Pedidos da dona ---------------------------------------------------------------------
create table if not exists billing_owner_requests (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  user_id        uuid not null,
  email          text not null check (email = lower(email)),
  preapproval_id text not null,
  action         text not null default 'cancel' check (action in ('cancel')),
  reason         text check (char_length(reason) <= 500),
  result         text not null default 'requested' check (result in ('requested', 'ok', 'error')),
  detail         text check (char_length(detail) <= 300),
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists billing_owner_requests_company_idx on billing_owner_requests (company_id, created_at desc);
alter table billing_owner_requests enable row level security;
revoke all on billing_owner_requests from public, anon, authenticated;

-- 2. Origem 'owner' no histórico da assinatura -----------------------------------------
alter table billing_subscription_events drop constraint if exists billing_subscription_events_source_check;
alter table billing_subscription_events add constraint billing_subscription_events_source_check
  check (source in ('webhook', 'reconcile', 'admin', 'owner'));

-- Igual à 0039, só com 'owner' na lista de origens aceitas.
create or replace function billing_sync(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email  text := lower(btrim(coalesce(p ->> 'email', '')));
  v_status text := p ->> 'status';
  v_pre    text := nullif(btrim(coalesce(p ->> 'preapproval_id', '')), '');
  v_mod    timestamptz := coalesce((p ->> 'last_modified')::timestamptz, now());
  v_source text := coalesce(p ->> 'source', 'webhook');
  v_cur    billing_accounts;
  v_last   text;
  v_applied boolean := false;
  v_event   boolean := false;
begin
  if v_email = '' or v_pre is null or v_status not in ('trialing', 'active', 'past_due', 'canceled', 'pending') then
    raise exception 'Dados de assinatura inválidos.' using errcode = '22023';
  end if;
  if v_source not in ('webhook', 'reconcile', 'admin', 'owner') then v_source := 'webhook'; end if;

  select * into v_cur from billing_accounts where email = v_email for update;

  -- Situação da conta: só um dado mais novo (ou igual) substitui o atual.
  if not found then
    insert into billing_accounts (email, status, provider, preapproval_id, next_payment_at, mp_status, plan_amount,
                                  currency, payer_id, started_at, canceled_at, mp_last_modified)
    values (v_email, v_status, 'mercadopago', v_pre, (p ->> 'next_payment_at')::timestamptz, p ->> 'mp_status',
            (p ->> 'amount')::numeric, p ->> 'currency', p ->> 'payer_id', (p ->> 'date_created')::timestamptz,
            case when v_status = 'canceled' then v_mod end, v_mod);
    v_applied := true;
  -- Assinatura nova depois de cancelar tem last_modified mais novo; um aviso atrasado
  -- de uma assinatura antiga não sobrescreve a atual.
  elsif v_cur.mp_last_modified is null or v_mod >= v_cur.mp_last_modified then
    update billing_accounts set
      status           = case when status = 'free' then 'free' else v_status end,   -- cortesia nunca é rebaixada
      provider         = case when status = 'free' then provider else 'mercadopago' end,
      preapproval_id   = v_pre,
      next_payment_at  = (p ->> 'next_payment_at')::timestamptz,
      mp_status        = p ->> 'mp_status',
      plan_amount      = coalesce((p ->> 'amount')::numeric, plan_amount),
      currency         = coalesce(p ->> 'currency', currency),
      payer_id         = coalesce(p ->> 'payer_id', payer_id),
      started_at       = coalesce((p ->> 'date_created')::timestamptz, started_at),
      canceled_at      = case when v_status = 'canceled' then coalesce(canceled_at, v_mod)
                              else null end,
      mp_last_modified = v_mod,
      updated_at       = now()
    where email = v_email;
    v_applied := true;
  end if;

  -- Histórico: registra a mudança na data em que aconteceu, sem repetir a mesma
  -- situação seguida (aviso repetido) e aceitando um aviso antigo que chegou depois.
  select e.status into v_last from billing_subscription_events e
  where e.preapproval_id = v_pre and e.occurred_at <= v_mod
  order by e.occurred_at desc, e.id desc limit 1;
  if v_last is distinct from v_status then
    insert into billing_subscription_events (preapproval_id, email, status, mp_status, occurred_at, source)
    values (v_pre, v_email, v_status, p ->> 'mp_status', v_mod, v_source)
    on conflict (preapproval_id, status, occurred_at) do nothing;
    v_event := found;
  end if;

  return jsonb_build_object('status', (select status from billing_accounts where email = v_email),
                            'applied', v_applied, 'event', v_event);
end;
$$;
revoke all on function billing_sync(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function billing_sync(jsonb) to service_role;
  end if;
end $$;

-- 3. Quem é a dona logada desta empresa -------------------------------------------------
-- Devolve o e-mail (minúsculo) da usuária logada SE ela for dona ativa da empresa.
create or replace function owner_email_for(p_company_id uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_email text;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select lower(u.email) into v_email
  from company_members m join auth.users u on u.id = m.user_id
  where m.company_id = p_company_id and m.user_id = auth.uid() and m.role = 'owner' and m.active;
  if v_email is null then
    raise exception 'Só a dona da conta pode ver e mudar a assinatura.' using errcode = '42501';
  end if;
  return v_email;
end;
$$;
revoke all on function owner_email_for(uuid) from public, anon, authenticated;

-- 4. A assinatura, como a dona vê -----------------------------------------------------------
create or replace function my_subscription(p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_email text := owner_email_for(p_company_id);
  b billing_accounts;
  v_pending boolean;
  v_payments jsonb;
begin
  select * into b from billing_accounts where email = v_email;
  if not found then
    return jsonb_build_object('status', 'none', 'access', get_company_access(p_company_id), 'can_cancel', false,
                              'payments', '[]'::jsonb);
  end if;

  select exists (select 1 from billing_owner_requests r
                 where r.company_id = p_company_id and r.result = 'requested' and r.created_at > now() - interval '2 minutes')
    into v_pending;

  -- Cobranças da assinatura atual: a mais recente primeiro. Sem taxas nem líquido.
  select coalesce(jsonb_agg(x order by x ->> 'at' desc), '[]'::jsonb) into v_payments from (
    select jsonb_build_object('at', coalesce(p.paid_at, p.debit_date, p.created_at), 'status', p.status,
                              'amount', p.amount, 'refunded', p.refunded_amount) as x
    from billing_payments p
    where b.preapproval_id is not null and p.preapproval_id = b.preapproval_id
    order by coalesce(p.paid_at, p.debit_date, p.created_at) desc
    limit 24
  ) t;

  return jsonb_build_object(
    'status', b.status,
    'provider', b.provider,
    'mp_status', b.mp_status,
    'amount', b.plan_amount,
    'currency', b.currency,
    'started_at', b.started_at,
    'trial_ends_at', case when b.started_at is not null then b.started_at + interval '7 days' end,
    'next_payment_at', b.next_payment_at,
    'canceled_at', b.canceled_at,
    'access', get_company_access(p_company_id),
    'can_cancel', b.status <> 'free' and b.provider = 'mercadopago' and b.preapproval_id is not null
                  and coalesce(b.mp_status, '') <> 'cancelled' and not v_pending,
    'cancel_pending', v_pending,
    'payments', v_payments
  );
end;
$$;

-- 5. Cancelamento pedido pela dona -----------------------------------------------------------
create or replace function owner_cancel_prepare(p_company_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text := owner_email_for(p_company_id);
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  b billing_accounts;
  v_id uuid;
begin
  select * into b from billing_accounts where email = v_email for update;
  if not found or b.provider is distinct from 'mercadopago' or b.preapproval_id is null or b.status = 'free' then
    raise exception 'Esta conta não tem assinatura no Mercado Pago para cancelar.' using errcode = '22023';
  end if;
  if b.mp_status = 'cancelled' then
    raise exception 'A assinatura já está cancelada.' using errcode = '22023';
  end if;
  -- Um pedido de cada vez (clique duplo, duas abas).
  if exists (select 1 from billing_owner_requests r where r.company_id = p_company_id and r.result = 'requested'
             and r.created_at > now() - interval '2 minutes') then
    raise exception 'Já estamos cancelando. Aguarde um instante.' using errcode = '55P03';
  end if;
  insert into billing_owner_requests (company_id, user_id, email, preapproval_id, reason)
  values (p_company_id, auth.uid(), v_email, b.preapproval_id, v_reason)
  returning id into v_id;
  return jsonb_build_object('request_id', v_id, 'preapproval_id', b.preapproval_id);
end;
$$;

create or replace function owner_cancel_finish(p_request_id uuid, p_ok boolean, p_detail text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r billing_owner_requests;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into r from billing_owner_requests where id = p_request_id and user_id = auth.uid() and result = 'requested'
  for update;
  if not found then raise exception 'Pedido de cancelamento não encontrado.' using errcode = 'P0002'; end if;
  update billing_owner_requests
     set result = case when p_ok then 'ok' else 'error' end, detail = left(coalesce(p_detail, ''), 300), finished_at = now()
   where id = p_request_id;
  return jsonb_build_object('ok', p_ok, 'access', get_company_access(r.company_id));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['my_subscription(uuid)', 'owner_cancel_prepare(uuid, text)', 'owner_cancel_finish(uuid, boolean, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
