-- ---------------------------------------------------------------------------
-- 0039 — FASE 3: histórico de assinaturas e pagamentos (Mercado Pago).
--
-- Só ACRESCENTA. Nada existente é alterado ou apagado; billing_upsert (0037)
-- continua igual. A função mp-webhook (v4) passa a usar:
--   * billing_sync(jsonb): grava a situação ATUAL da assinatura (consultada no
--     próprio Mercado Pago) + o histórico de mudanças;
--   * billing_record_payment(jsonb): grava cada cobrança da assinatura.
--
-- Garantias:
--   * Aviso repetido: não duplica (chaves = ids do Mercado Pago).
--   * Aviso fora de ordem: a situação da conta só é trocada por um dado MAIS NOVO
--     (last_modified do Mercado Pago); o histórico guarda cada mudança na sua data.
--   * Cortesia ('free') nunca é rebaixada (mesma regra da 0037).
--   * Minimização: nada de cartão, documento ou endereço; só ids, valores e datas.
--   * Ninguém lê nem escreve pela API: só as funções do servidor (service_role) e,
--     para leitura, as funções admin_* do painel (Fase 3, parte 2).
-- A medição começa quando a 0039 é aplicada: não há dados retroativos.
-- ---------------------------------------------------------------------------

-- 1. Mais dados da assinatura atual ------------------------------------------------
alter table billing_accounts
  add column if not exists mp_status        text,           -- pending | authorized | paused | cancelled
  add column if not exists plan_amount      numeric(12, 2), -- valor mensal contratado (auto_recurring)
  add column if not exists currency         text,
  add column if not exists payer_id         text,
  add column if not exists started_at       timestamptz,    -- date_created da assinatura
  add column if not exists canceled_at      timestamptz,
  add column if not exists mp_last_modified timestamptz;

-- 2. Histórico de situação (uma linha por mudança) ------------------------------------
create table if not exists billing_subscription_events (
  id             bigint generated always as identity primary key,
  preapproval_id text not null,
  email          text not null check (email = lower(email)),
  status         text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'pending')),
  mp_status      text,
  occurred_at    timestamptz not null,   -- last_modified do Mercado Pago
  recorded_at    timestamptz not null default now(),
  source         text not null default 'webhook' check (source in ('webhook', 'reconcile', 'admin')),
  unique (preapproval_id, status, occurred_at)
);
create index if not exists billing_events_pre_idx on billing_subscription_events (preapproval_id, occurred_at desc);
create index if not exists billing_events_at_idx on billing_subscription_events (occurred_at desc);

-- 3. Cobranças da assinatura (authorized_payments + o pagamento gerado) ---------------
create table if not exists billing_payments (
  authorized_payment_id text primary key,
  preapproval_id        text not null,
  email                 text check (email = lower(email)),
  payment_id            text,
  ap_status             text,          -- scheduled | processed | recycling | cancelled (cobrança)
  status                text not null check (status in ('approved', 'pending', 'in_process', 'authorized', 'rejected',
                                                          'refunded', 'charged_back', 'cancelled', 'scheduled', 'unknown')),
  status_detail         text,
  amount                numeric(12, 2),   -- bruto cobrado
  refunded_amount       numeric(12, 2) not null default 0,
  fee_amount            numeric(12, 2),   -- taxas pagas pela Áurea (quando o Mercado Pago informa)
  net_amount            numeric(12, 2),   -- líquido recebido segundo o Mercado Pago
  currency              text,
  paid_at               timestamptz,      -- date_approved
  debit_date            timestamptz,
  retry_attempt         int,
  mp_last_modified      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists billing_payments_pre_idx on billing_payments (preapproval_id);
create index if not exists billing_payments_paid_idx on billing_payments (paid_at desc);
create index if not exists billing_payments_status_idx on billing_payments (status);

alter table billing_subscription_events enable row level security;
alter table billing_payments enable row level security;
revoke all on billing_subscription_events, billing_payments from public, anon, authenticated;

-- 4. Sincronizar a assinatura -------------------------------------------------------------
-- p: { email, status, preapproval_id, mp_status, next_payment_at, last_modified,
--      amount, currency, payer_id, date_created, source }
-- Devolve { status (da conta), changed, applied, event }.
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
  if v_source not in ('webhook', 'reconcile', 'admin') then v_source := 'webhook'; end if;

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

-- 5. Gravar uma cobrança ------------------------------------------------------------------
-- p: { authorized_payment_id, preapproval_id, email, payment_id, ap_status, status, status_detail,
--      amount, refunded_amount, fee_amount, net_amount, currency, paid_at, debit_date,
--      retry_attempt, last_modified }
-- Aviso repetido: atualiza a mesma linha. Fora de ordem: só substitui por dado mais novo.
create or replace function billing_record_payment(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id   text := nullif(btrim(coalesce(p ->> 'authorized_payment_id', '')), '');
  v_pre  text := nullif(btrim(coalesce(p ->> 'preapproval_id', '')), '');
  v_mod  timestamptz := coalesce((p ->> 'last_modified')::timestamptz, now());
  v_st   text := coalesce(p ->> 'status', 'unknown');
  v_rows int;
begin
  if v_id is null or v_pre is null then
    raise exception 'Cobrança sem identificação.' using errcode = '22023';
  end if;
  if v_st not in ('approved', 'pending', 'in_process', 'authorized', 'rejected', 'refunded', 'charged_back',
                  'cancelled', 'scheduled', 'unknown') then
    v_st := 'unknown';
  end if;

  insert into billing_payments (authorized_payment_id, preapproval_id, email, payment_id, ap_status, status, status_detail,
                                amount, refunded_amount, fee_amount, net_amount, currency, paid_at, debit_date,
                                retry_attempt, mp_last_modified)
  values (v_id, v_pre, nullif(lower(btrim(coalesce(p ->> 'email', ''))), ''), p ->> 'payment_id', p ->> 'ap_status', v_st,
          p ->> 'status_detail', (p ->> 'amount')::numeric, coalesce((p ->> 'refunded_amount')::numeric, 0),
          (p ->> 'fee_amount')::numeric, (p ->> 'net_amount')::numeric, p ->> 'currency',
          (p ->> 'paid_at')::timestamptz, (p ->> 'debit_date')::timestamptz, (p ->> 'retry_attempt')::int, v_mod)
  on conflict (authorized_payment_id) do update set
    preapproval_id   = excluded.preapproval_id,
    email            = coalesce(excluded.email, billing_payments.email),
    payment_id       = coalesce(excluded.payment_id, billing_payments.payment_id),
    ap_status        = excluded.ap_status,
    status           = excluded.status,
    status_detail    = excluded.status_detail,
    amount           = coalesce(excluded.amount, billing_payments.amount),
    refunded_amount  = greatest(excluded.refunded_amount, billing_payments.refunded_amount),  -- reembolso não "desfaz"
    fee_amount       = coalesce(excluded.fee_amount, billing_payments.fee_amount),
    net_amount       = coalesce(excluded.net_amount, billing_payments.net_amount),
    currency         = coalesce(excluded.currency, billing_payments.currency),
    paid_at          = coalesce(excluded.paid_at, billing_payments.paid_at),
    debit_date       = coalesce(excluded.debit_date, billing_payments.debit_date),
    retry_attempt    = excluded.retry_attempt,
    mp_last_modified = excluded.mp_last_modified,
    updated_at       = now()
  where billing_payments.mp_last_modified is null or excluded.mp_last_modified >= billing_payments.mp_last_modified;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('applied', v_rows > 0,
                            'status', (select status from billing_payments where authorized_payment_id = v_id));
end;
$$;

-- 6. Permissões: só o servidor (função mp-webhook, service_role) --------------------------
revoke all on function billing_sync(jsonb) from public, anon, authenticated;
revoke all on function billing_record_payment(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function billing_sync(jsonb) to service_role;
    grant execute on function billing_record_payment(jsonb) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
