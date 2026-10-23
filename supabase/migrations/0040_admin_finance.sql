-- ---------------------------------------------------------------------------
-- 0040 — FASE 3 (parte 2): financeiro no painel, cancelamento e conciliação.
--
-- Só leitura dos dados de cobrança (0039) pelo painel, sempre com admin_assert()
-- (superadmin + MFA). Nada é gravado em billing_* por estas funções: quem grava é
-- o servidor (mp-webhook e admin-billing, service_role) com billing_sync /
-- billing_record_payment, depois de consultar o Mercado Pago.
--
-- DEFINIÇÕES (as mesmas que a tela mostra):
--   * Cobrado aprovado (bruto): soma das cobranças aprovadas (inclui as que depois
--     foram reembolsadas ou estornadas), pela data de aprovação.
--   * Reembolsos / estornos: valor devolvido das cobranças aprovadas no período.
--   * Recebido: cobrado aprovado − reembolsos − estornos (ainda bruto de taxas).
--   * Taxas: taxas do Mercado Pago pagas pela Áurea, quando informadas.
--   * Líquido: valor líquido informado pelo Mercado Pago (após taxas) das cobranças
--     aprovadas e não devolvidas.
--   * Pendente: cobranças agendadas/em processamento no período (não é receita).
--   * Recusado: cobranças recusadas no período (o Mercado Pago tenta de novo).
--   * Ticket médio: recebido ÷ assinaturas que pagaram no período.
--   * MRR contratado: soma do valor mensal das assinaturas 'active' (pagas).
--   * Conversão (coorte): das assinaturas que COMEÇARAM em teste no período, quantas
--     já tiveram uma cobrança aprovada. As que ainda estão em teste aparecem à parte.
--   * Churn pago: assinaturas pagas (ativas ou atrasadas no início do período) que
--     foram canceladas no período ÷ assinaturas pagas no início do período.
--   * Previsão (30 dias): valor mensal das assinaturas ativas/atrasadas com próxima
--     cobrança nos próximos 30 dias. É previsão, não receita.
-- A medição começou com a 0039 (23/10/2026): não há dados anteriores.
-- ---------------------------------------------------------------------------

-- 1. Auditoria: pedido de cancelamento registrado antes de falar com o Mercado Pago
alter table admin_audit_log drop constraint if exists admin_audit_log_result_check;
alter table admin_audit_log add constraint admin_audit_log_result_check
  check (result in ('ok', 'noop', 'error', 'requested'));

-- 2. Início da medição (aplicação da 0039 em produção) ------------------------------
create or replace function billing_measuring_since() returns timestamptz
language sql immutable as $$ select timestamptz '2026-10-23 16:43:45+00' $$;

-- Dona (empresa) de cada e-mail de cobrança, para as listas do painel.
create or replace function admin_company_by_email(p_email text)
returns table (company_id uuid, company_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.name from company_members m join auth.users u on u.id = m.user_id join companies c on c.id = m.company_id
  where lower(u.email) = lower(p_email) and m.role = 'owner' and m.active
  order by m.created_at limit 1;
$$;
revoke all on function admin_company_by_email(text) from public, anon, authenticated;

-- 3. Visão financeira ---------------------------------------------------------------
create or replace function admin_finance_overview(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  perform admin_assert();
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  with
  paid as (   -- aprovadas no período (pela data de aprovação)
    select * from billing_payments
    where status in ('approved', 'refunded', 'charged_back') and paid_at >= p_from and paid_at < p_to),
  other as (  -- não aprovadas, pela data da cobrança
    select * from billing_payments
    where status not in ('approved', 'refunded', 'charged_back')
      and coalesce(debit_date, created_at) >= p_from and coalesce(debit_date, created_at) < p_to),
  first_ev as (  -- primeira situação de cada assinatura
    select distinct on (preapproval_id) preapproval_id, status, occurred_at
    from billing_subscription_events order by preapproval_id, occurred_at, id),
  cohort as (select preapproval_id from first_ev where status = 'trialing' and occurred_at >= p_from and occurred_at < p_to),
  base as (     -- pagas (ativas/atrasadas) no início do período
    select distinct on (preapproval_id) preapproval_id, status
    from billing_subscription_events where occurred_at < p_from order by preapproval_id, occurred_at desc, id desc),
  churned as (
    select distinct e.preapproval_id from billing_subscription_events e
    join base b on b.preapproval_id = e.preapproval_id and b.status in ('active', 'past_due')
    where e.status = 'canceled' and e.occurred_at >= p_from and e.occurred_at < p_to),
  cur as (select * from billing_accounts where provider = 'mercadopago')
  select jsonb_build_object(
    'measuring_since', billing_measuring_since(),
    'gross_approved', coalesce((select sum(amount) from paid), 0),
    'refunded', coalesce((select sum(refunded_amount) from paid where status <> 'charged_back'), 0),
    'charged_back', coalesce((select sum(amount) from paid where status = 'charged_back'), 0),
    'received', coalesce((select sum(case when status = 'charged_back' then 0 else amount - refunded_amount end) from paid), 0),
    'fees', coalesce((select sum(fee_amount) from paid where status = 'approved'), 0),
    'fees_unknown', (select count(*) from paid where status = 'approved' and fee_amount is null),
    'net', coalesce((select sum(net_amount) from paid where status = 'approved' and refunded_amount = 0), 0),
    'net_unknown', (select count(*) from paid where status = 'approved' and refunded_amount = 0 and net_amount is null),
    'approved_count', (select count(*) from paid),
    'paying_subscriptions', (select count(distinct preapproval_id) from paid where status <> 'charged_back'),
    'pending_amount', coalesce((select sum(amount) from other where status in ('pending', 'in_process', 'authorized', 'scheduled')), 0),
    'pending_count', (select count(*) from other where status in ('pending', 'in_process', 'authorized', 'scheduled')),
    'rejected_amount', coalesce((select sum(amount) from other where status = 'rejected'), 0),
    'rejected_count', (select count(*) from other where status = 'rejected'),
    'mrr_contracted', coalesce((select sum(plan_amount) from cur where status = 'active'), 0),
    'mrr_unknown', (select count(*) from cur where status = 'active' and plan_amount is null),
    'past_due_now', (select count(*) from cur where status = 'past_due'),
    'forecast_30d', coalesce((select sum(plan_amount) from cur where status in ('active', 'past_due')
                               and next_payment_at >= now() and next_payment_at < now() + interval '30 days'), 0),
    'trials_ending_30d', (select count(*) from cur where status = 'trialing' and next_payment_at < now() + interval '30 days'),
    'cohort_trials', (select count(*) from cohort),
    'cohort_converted', (select count(*) from cohort c where exists (
                           select 1 from billing_payments p where p.preapproval_id = c.preapproval_id
                           and p.status in ('approved', 'refunded', 'charged_back'))),
    'cohort_still_trial', (select count(*) from cohort c join cur a on a.preapproval_id = c.preapproval_id and a.status = 'trialing'),
    'churn_base', (select count(*) from base where status in ('active', 'past_due')),
    'churn_canceled', (select count(*) from churned),
    -- cancelou ainda em teste = a situação imediatamente anterior ao cancelamento era 'trialing'
    'trial_canceled', (select count(distinct e.preapproval_id) from billing_subscription_events e
                       where e.status = 'canceled' and e.occurred_at >= p_from and e.occurred_at < p_to
                         and (select pe.status from billing_subscription_events pe
                              where pe.preapproval_id = e.preapproval_id and pe.occurred_at < e.occurred_at
                              order by pe.occurred_at desc, pe.id desc limit 1) = 'trialing'),
    'revenue_by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'received', v) order by m), '[]'::jsonb)
                         from (select gs as m, coalesce((select sum(case when status = 'charged_back' then 0 else amount - refunded_amount end)
                                  from billing_payments where status in ('approved', 'refunded', 'charged_back')
                                    and date_trunc('month', paid_at at time zone 'America/Sao_Paulo') = gs), 0) v
                               -- 12 meses terminando no mês do fim do período escolhido
                               from generate_series(date_trunc('month', ((p_to - interval '1 second') at time zone 'America/Sao_Paulo') - interval '11 months'),
                                                    date_trunc('month', (p_to - interval '1 second') at time zone 'America/Sao_Paulo'), interval '1 month') gs) x)
  ) into r;
  return r;
end;
$$;

-- 4. Listas: cobranças e mudanças de situação -----------------------------------------
create or replace function admin_list_billing(p_kind text, p_status text default null,
                                              p_from timestamptz default null, p_to timestamptz default null,
                                              p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  r jsonb;
begin
  perform admin_assert();
  if p_kind = 'payments' then
    with f as (
      select p.*, coalesce(p.paid_at, p.debit_date, p.created_at) as at, c.company_id, c.company_name
      from billing_payments p left join lateral admin_company_by_email(p.email) c on true
      where (p_status is null or p.status = p_status)
        and (p_from is null or coalesce(p.paid_at, p.debit_date, p.created_at) >= p_from)
        and (p_to is null or coalesce(p.paid_at, p.debit_date, p.created_at) < p_to))
    select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(jsonb_build_object(
             'id', authorized_payment_id, 'at', at, 'status', status, 'status_detail', status_detail, 'amount', amount,
             'refunded', refunded_amount, 'fee', fee_amount, 'net', net_amount, 'retry', retry_attempt,
             'company_id', company_id, 'company_name', company_name, 'email', email) order by at desc)
           from (select * from f order by at desc limit v_limit offset v_offset) x), '[]'::jsonb)) into r;
  elsif p_kind = 'events' then
    with f as (
      select e.*, c.company_id, c.company_name
      from billing_subscription_events e left join lateral admin_company_by_email(e.email) c on true
      where (p_status is null or e.status = p_status)
        and (p_from is null or e.occurred_at >= p_from) and (p_to is null or e.occurred_at < p_to))
    select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(jsonb_build_object(
             'at', occurred_at, 'status', status, 'mp_status', mp_status, 'source', source, 'preapproval_id', preapproval_id,
             'company_id', company_id, 'company_name', company_name, 'email', email) order by occurred_at desc)
           from (select * from f order by occurred_at desc, id desc limit v_limit offset v_offset) x), '[]'::jsonb)) into r;
  else
    raise exception 'Lista desconhecida.' using errcode = '22023';
  end if;
  return r;
end;
$$;

-- 5. Cancelamento pelo painel ------------------------------------------------------------
-- A função admin-billing (servidor) chama prepare com a SESSÃO da superadmin (MFA),
-- cancela no Mercado Pago, sincroniza pelo Mercado Pago e chama finish. O pedido fica
-- na auditoria ANTES da chamada externa: mesmo que ela caia no meio, há registro.
create or replace function admin_cancel_prepare(p_company_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_email text;
  b billing_accounts;
  v_corr uuid;
begin
  perform admin_assert();
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'Informe o motivo (de 5 a 500 caracteres).' using errcode = '22023';
  end if;
  select lower(u.email) into v_email from company_members m join auth.users u on u.id = m.user_id
  where m.company_id = p_company_id and m.role = 'owner' and m.active order by m.created_at limit 1;
  if v_email is null then raise exception 'Conta não encontrada.' using errcode = 'P0002'; end if;
  select * into b from billing_accounts where email = v_email;
  if not found or b.preapproval_id is null then
    raise exception 'Esta conta não tem assinatura no Mercado Pago.' using errcode = '22023';
  end if;
  if b.mp_status = 'cancelled' then
    raise exception 'A assinatura já está cancelada no Mercado Pago.' using errcode = '22023';
  end if;
  v_corr := admin_log('cancel_subscription', p_company_id, 'requested', v_reason,
                      jsonb_build_object('preapproval_id', b.preapproval_id, 'status_before', b.status));
  return jsonb_build_object('preapproval_id', b.preapproval_id, 'email', v_email, 'correlation_id', v_corr,
                            'courtesy', b.status = 'free');
end;
$$;

create or replace function admin_cancel_finish(p_company_id uuid, p_correlation_id uuid, p_ok boolean, p_detail text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_corr uuid;
begin
  perform admin_assert();
  if not exists (select 1 from admin_audit_log where correlation_id = p_correlation_id and action = 'cancel_subscription'
                 and result = 'requested' and company_id = p_company_id and admin_id = auth.uid()) then
    raise exception 'Pedido de cancelamento não encontrado.' using errcode = 'P0002';
  end if;
  v_corr := admin_log('cancel_subscription', p_company_id, case when p_ok then 'ok' else 'error' end, null,
                      jsonb_build_object('request', p_correlation_id, 'detail', left(coalesce(p_detail, ''), 300),
                                         'status_after', (select b.status from billing_accounts b
                                           where b.email = (select lower(u.email) from company_members m join auth.users u on u.id = m.user_id
                                                            where m.company_id = p_company_id and m.role = 'owner' and m.active
                                                            order by m.created_at limit 1))));
  return jsonb_build_object('correlation_id', v_corr);
end;
$$;

-- 6. Conciliação ---------------------------------------------------------------------------
-- Lista o que conferir no Mercado Pago (assinaturas conhecidas) e registra o resultado.
create or replace function admin_reconcile_targets()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform admin_assert();
  return (select coalesce(jsonb_agg(distinct pre), '[]'::jsonb) from (
            select preapproval_id as pre from billing_accounts where preapproval_id is not null and provider = 'mercadopago'
            union select preapproval_id from billing_subscription_events
            union select preapproval_id from billing_payments) t
          where pre is not null);
end;
$$;

create or replace function admin_log_reconcile(p_details jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform admin_assert();
  return admin_log('reconcile', null, case when coalesce((p_details ->> 'errors')::int, 0) = 0 then 'ok' else 'error' end,
                   null, coalesce(p_details, '{}'::jsonb) - 'emails');
end;
$$;

-- 7. Ficha da conta: + cobranças e histórico da assinatura (mesma minimização da 0038) ---
create or replace function admin_get_account(p_company_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record;
  r jsonb;
begin
  perform admin_assert();
  select * into a from admin_accounts_base() where company_id = p_company_id;
  if not found then raise exception 'Conta não encontrada.' using errcode = 'P0002'; end if;

  select jsonb_build_object(
    'account', to_jsonb(a),
    'company', (select jsonb_build_object('phone', c.phone, 'email', c.email, 'plan', c.plan, 'legacy_status', c.status)
                from companies c where c.id = p_company_id),
    'owner', (select jsonb_build_object('created_at', u.created_at, 'email_confirmed_at', u.email_confirmed_at,
                                        'last_sign_in_at', u.last_sign_in_at, 'banned_until', u.banned_until)
              from auth.users u where u.id = a.owner_id),
    'billing', (select jsonb_build_object('status', b.status, 'provider', b.provider, 'preapproval_id', b.preapproval_id,
                                          'next_payment_at', b.next_payment_at, 'updated_at', b.updated_at,
                                          'mp_status', b.mp_status, 'plan_amount', b.plan_amount, 'currency', b.currency,
                                          'started_at', b.started_at, 'canceled_at', b.canceled_at)
                from billing_accounts b where b.email = lower(a.owner_email)),
    'suspension', (select jsonb_build_object('suspended_at', f.suspended_at, 'reason', f.suspended_reason, 'updated_at', f.updated_at)
                   from admin_account_flags f where f.company_id = p_company_id),
    'team', (select coalesce(jsonb_agg(jsonb_build_object(
                'role', m.role, 'active', m.active, 'since', m.created_at,
                'name', coalesce(nullif(btrim(p.full_name), ''), 'Sem nome')) order by m.created_at), '[]'::jsonb)
             from company_members m left join profiles p on p.id = m.user_id where m.company_id = p_company_id),
    'usage', jsonb_build_object(
      'appointments_total', (select count(*) from appointments x where x.company_id = p_company_id),
      'appointments_30d', (select count(*) from appointments x where x.company_id = p_company_id and x.created_at > now() - interval '30 days'),
      'appointments_upcoming', (select count(*) from appointments x where x.company_id = p_company_id
                                 and x.scheduled_start >= now() and x.status in ('agendado', 'confirmado')),
      'first_appointment_at', (select min(x.created_at) from appointments x where x.company_id = p_company_id),
      'last_appointment_at', (select max(x.created_at) from appointments x where x.company_id = p_company_id),
      'clients', (select count(*) from clients x where x.company_id = p_company_id and x.archived_at is null),
      'services', (select count(*) from services x where x.company_id = p_company_id and x.active),
      'team_active', (select count(*) from company_members x where x.company_id = p_company_id and x.active)),
    'whatsapp', (select jsonb_build_object('status', s.status, 'connected_at', s.connected_at, 'last_seen_at', s.last_seen_at,
                                           'auto_confirmation', s.auto_confirmation, 'reminder', s.reminder)
                 from whatsapp_private.sessions s where s.company_id = p_company_id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', bp.authorized_payment_id, 'payment_id', bp.payment_id, 'status', bp.status, 'status_detail', bp.status_detail,
                    'amount', bp.amount, 'refunded', bp.refunded_amount, 'fee', bp.fee_amount, 'net', bp.net_amount,
                    'paid_at', bp.paid_at, 'debit_date', bp.debit_date, 'retry', bp.retry_attempt, 'created_at', bp.created_at)
                  order by coalesce(bp.paid_at, bp.debit_date, bp.created_at) desc), '[]'::jsonb)
                 from (select * from billing_payments where email = lower(a.owner_email)
                       order by coalesce(paid_at, debit_date, created_at) desc limit 24) bp),
    'payments_total', (select jsonb_build_object(
                         'received', coalesce(sum(amount - refunded_amount) filter (where status in ('approved', 'refunded')), 0),
                         'refunded', coalesce(sum(refunded_amount), 0),
                         'approved_count', count(*) filter (where status in ('approved', 'refunded')))
                       from billing_payments where email = lower(a.owner_email)),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'mp_status', e.mp_status, 'at', e.occurred_at,
                                                             'source', e.source) order by e.occurred_at desc, e.id desc), '[]'::jsonb)
               from (select * from billing_subscription_events where email = lower(a.owner_email)
                     order by occurred_at desc, id desc limit 50) e),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'at', n.created_at) order by n.created_at desc), '[]'::jsonb)
              from admin_notes n where n.company_id = p_company_id),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'result', l.result, 'reason', l.reason,
                                                            'details', l.details) order by l.at desc), '[]'::jsonb)
              from (select * from admin_audit_log where company_id = p_company_id order by at desc limit 50) l)
  ) into r;
  perform admin_log('view_account', p_company_id, 'ok', null, '{}'::jsonb);
  return r;
end;
$$;

-- 8. Permissões ------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'admin_finance_overview(timestamptz, timestamptz)',
    'admin_list_billing(text, text, timestamptz, timestamptz, int, int)',
    'admin_cancel_prepare(uuid, text)', 'admin_cancel_finish(uuid, uuid, boolean, text)',
    'admin_reconcile_targets()', 'admin_log_reconcile(jsonb)', 'admin_get_account(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
