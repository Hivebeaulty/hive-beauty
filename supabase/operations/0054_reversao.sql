-- Reversão da 0054 (cortesia com prazo). SÓ rode com autorização.
-- Cortesias com prazo viram cortesias SEM prazo (continuam liberadas) — por isso, antes, decida se quer
-- encerrá-las. O registro de quem recebeu (billing_courtesies) é apagado: guarde uma cópia se precisar.
begin;

CREATE OR REPLACE FUNCTION public.get_company_access(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_status text; v_email text; v_until timestamptz; v_provider text; v_trial_end timestamptz;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  if not is_company_member(p_company_id) then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if exists (select 1 from admin_account_flags f where f.company_id = p_company_id and f.suspended_at is not null) then
    return jsonb_build_object('status', 'suspended', 'allowed', false, 'warning', false);
  end if;
  select b.status, b.email, b.provider, b.trial_ends_at into v_status, v_email, v_provider, v_trial_end
  from company_members m join auth.users u on u.id = m.user_id join billing_accounts b on b.email = lower(u.email)
  where m.company_id = p_company_id and m.role = 'owner' and m.active
  order by array_position(array['free', 'active', 'trialing', 'past_due', 'pending', 'canceled'], b.status) limit 1;
  v_status := coalesce(v_status, 'none');
  if v_provider = 'trial' and v_status = 'trialing' then
    if v_trial_end > now() then
      return jsonb_build_object('status', 'trialing', 'allowed', true,
                                'warning', v_trial_end < now() + interval '3 days', 'until', v_trial_end);
    end if;
    return jsonb_build_object('status', 'trial_ended', 'allowed', false, 'warning', false);
  end if;
  if v_status = 'canceled' then
    select max(paid_at) + interval '1 month' into v_until from billing_payments
    where email = v_email and status in ('approved', 'refunded') and amount > refunded_amount;
    if v_until > now() then
      return jsonb_build_object('status', 'ending', 'allowed', true, 'warning', true, 'until', v_until);
    end if;
  end if;
  return jsonb_build_object('status', v_status, 'allowed', v_status in ('free', 'trialing', 'active', 'past_due'),
                            'warning', v_status = 'past_due');
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_access()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_status text; v_provider text; v_trial_end timestamptz;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select b.status, b.provider, b.trial_ends_at into v_status, v_provider, v_trial_end
  from auth.users u join billing_accounts b on b.email = lower(u.email) where u.id = auth.uid();
  v_status := coalesce(v_status, 'none');
  if v_provider = 'trial' and v_status = 'trialing' then
    if v_trial_end > now() then
      return jsonb_build_object('status', 'trialing', 'allowed', true,
                                'warning', v_trial_end < now() + interval '3 days', 'until', v_trial_end);
    end if;
    return jsonb_build_object('status', 'trial_ended', 'allowed', false, 'warning', false);
  end if;
  return jsonb_build_object('status', v_status, 'allowed', v_status in ('free', 'trialing', 'active', 'past_due'), 'warning', v_status = 'past_due');
end;
$function$;

CREATE OR REPLACE FUNCTION public.my_subscription(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    'trial_ends_at', case when b.provider = 'trial' then b.trial_ends_at
                          when b.started_at is not null then b.started_at + interval '7 days' end,
    'next_payment_at', b.next_payment_at,
    'canceled_at', b.canceled_at,
    'access', get_company_access(p_company_id),
    'can_cancel', b.status <> 'free' and b.provider = 'mercadopago' and b.preapproval_id is not null
                  and coalesce(b.mp_status, '') <> 'cancelled' and not v_pending,
    'cancel_pending', v_pending,
    'payments', v_payments
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.billing_sync(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_accounts_base()
 RETURNS TABLE(company_id uuid, company_name text, is_demo boolean, created_at timestamp with time zone, owner_id uuid, owner_name text, owner_email text, owner_last_sign_in timestamp with time zone, billing_status text, billing_provider text, next_payment_at timestamp with time zone, billing_updated_at timestamp with time zone, suspended boolean, appointments_count bigint, clients_count bigint, services_count bigint, last_activity_at timestamp with time zone, whatsapp_status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.id, c.name, coalesce(c.is_demo, false), c.created_at,
         o.user_id, o.full_name, o.email, o.last_sign_in_at,
         coalesce(b.status, 'none'), b.provider, b.next_payment_at, b.updated_at,
         coalesce(f.suspended_at is not null, false),
         (select count(*) from appointments a where a.company_id = c.id),
         (select count(*) from clients cl where cl.company_id = c.id and cl.archived_at is null),
         (select count(*) from services s where s.company_id = c.id and s.active),
         (select max(a.created_at) from appointments a where a.company_id = c.id),
         (select ws.status from whatsapp_private.sessions ws where ws.company_id = c.id)
  from companies c
  left join lateral (
    select m.user_id, u.email::text as email, u.last_sign_in_at,
           coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(u.raw_user_meta_data ->> 'full_name'), '')) as full_name
    from company_members m join auth.users u on u.id = m.user_id left join profiles p on p.id = m.user_id
    where m.company_id = c.id and m.role = 'owner' and m.active
    order by m.created_at limit 1
  ) o on true
  left join lateral (
    select bb.* from company_members m join auth.users u on u.id = m.user_id join billing_accounts bb on bb.email = lower(u.email)
    where m.company_id = c.id and m.role = 'owner' and m.active
    order by array_position(array['free', 'active', 'trialing', 'past_due', 'pending', 'canceled'], bb.status) limit 1
  ) b on true
  left join admin_account_flags f on f.company_id = c.id;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_account(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

drop function if exists admin_courtesy_grant(text, text, integer, text, text);
drop function if exists admin_courtesy_extend(uuid, integer, text);
drop function if exists admin_courtesy_revoke(uuid, text);
drop function if exists admin_list_courtesies(text);
drop function if exists billing_effective_status(billing_accounts);
drop table if exists billing_courtesies;
alter table billing_accounts drop column if exists courtesy_ends_at;
alter table billing_accounts drop column if exists sub_status;

commit;
