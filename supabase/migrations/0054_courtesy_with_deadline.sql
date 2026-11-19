-- ---------------------------------------------------------------------------
-- 0054 — CORTESIA COM PRAZO (oferecida só pela dona, no painel SuperAdmin)
--
-- Hoje a cortesia é billing_accounts.status = 'free' / provider = 'cortesia', sem fim.
-- Esta migration acrescenta o PRAZO e o REGISTRO de quem recebeu. As cortesias que já existem
-- (courtesy_ends_at nulo) continuam sem prazo, exatamente como estão.
--
--   * billing_accounts.courtesy_ends_at  fim da cortesia (23:59:59 de Brasília do último dia).
--   * billing_accounts.sub_status        último status vindo do Mercado Pago, gravado sempre. Se a
--                                        profissional assinar DURANTE a cortesia, no fim dela o acesso
--                                        segue pela assinatura, sem bloquear quem paga.
--   * billing_courtesies                 registro de quem recebeu: e-mail, origem, motivo, dias, fim,
--                                        quem concedeu, extensões e revogação. Fechada para a API.
--   * billing_effective_status(b)        resolve na hora do acesso (sem cron, sem apagar dado):
--                                        'courtesy' dentro do prazo; depois, sub_status ou 'courtesy_ended'.
--   * get_company_access / get_my_access / my_subscription / billing_sync / admin_accounts_base /
--     admin_get_account passam a usar isso.
--   * admin_courtesy_grant / _extend / _revoke / admin_list_courtesies: só superadmin com a verificação
--     em duas etapas; motivo obrigatório (5 a 500); tudo vai para admin_audit_log.
--
-- Estados novos do acesso: 'courtesy' (liberado, com "until" e aviso nos últimos 7 dias) e
-- 'courtesy_ended' (bloqueado; dados guardados). O e-mail novo ganha o login pela função admin-courtesy.
-- Reversão: supabase/operations/0054_reversao.sql
-- ---------------------------------------------------------------------------

alter table billing_accounts add column if not exists courtesy_ends_at timestamptz;
alter table billing_accounts add column if not exists sub_status text;

create table if not exists billing_courtesies (
  id             uuid primary key default gen_random_uuid(),
  email          text not null check (email = lower(email)),
  company_id     uuid references companies(id) on delete set null,
  name           text,
  origin         text not null check (origin in ('parceria', 'indicacao', 'outro')),
  reason         text not null check (char_length(reason) between 5 and 500),
  days           integer not null check (days between 1 and 365),
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz not null,
  granted_by     uuid references auth.users(id) on delete set null,
  granted_at     timestamptz not null default now(),
  extensions     integer not null default 0,
  prior_status   text,
  prior_provider text,
  revoked_at     timestamptz,
  revoked_by     uuid references auth.users(id) on delete set null,
  revoked_reason text
);
create index if not exists billing_courtesies_email_idx on billing_courtesies (email, granted_at desc);
alter table billing_courtesies enable row level security;
revoke all on billing_courtesies from public, anon, authenticated;

-- Situação de acesso da linha de cobrança, na hora (cortesia vencida cai para o que o Mercado Pago diz).
create or replace function billing_effective_status(b billing_accounts)
returns text language sql stable set search_path = public, pg_temp as $$
  select case
    when b.status = 'free' and b.courtesy_ends_at is not null then
      case when b.courtesy_ends_at > now() then 'courtesy' else coalesce(b.sub_status, 'courtesy_ended') end
    else b.status
  end
$$;
revoke all on function billing_effective_status(billing_accounts) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_company_access(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_status text; v_email text; v_until timestamptz; v_provider text; v_trial_end timestamptz; v_courtesy_end timestamptz;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  if not is_company_member(p_company_id) then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if exists (select 1 from admin_account_flags f where f.company_id = p_company_id and f.suspended_at is not null) then
    return jsonb_build_object('status', 'suspended', 'allowed', false, 'warning', false);
  end if;
  select billing_effective_status(b), b.email, b.provider, b.trial_ends_at, b.courtesy_ends_at
  into v_status, v_email, v_provider, v_trial_end, v_courtesy_end
  from company_members m join auth.users u on u.id = m.user_id join billing_accounts b on b.email = lower(u.email)
  where m.company_id = p_company_id and m.role = 'owner' and m.active
  order by array_position(array['free', 'courtesy', 'active', 'trialing', 'past_due', 'pending', 'canceled', 'courtesy_ended'], billing_effective_status(b)) limit 1;
  v_status := coalesce(v_status, 'none');
  -- Cortesia com prazo (0054): vale até o fim do dia combinado; avisa nos últimos 7 dias.
  if v_status = 'courtesy' then
    return jsonb_build_object('status', 'courtesy', 'allowed', true,
                              'warning', v_courtesy_end < now() + interval '7 days', 'until', v_courtesy_end);
  end if;
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
declare v_status text; v_provider text; v_trial_end timestamptz; v_courtesy_end timestamptz;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select billing_effective_status(b), b.provider, b.trial_ends_at, b.courtesy_ends_at
  into v_status, v_provider, v_trial_end, v_courtesy_end
  from auth.users u join billing_accounts b on b.email = lower(u.email) where u.id = auth.uid();
  v_status := coalesce(v_status, 'none');
  if v_status = 'courtesy' then
    return jsonb_build_object('status', 'courtesy', 'allowed', true,
                              'warning', v_courtesy_end < now() + interval '7 days', 'until', v_courtesy_end);
  end if;
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
  v_eff text;
  v_prov text;
  v_pending boolean;
  v_payments jsonb;
begin
  select * into b from billing_accounts where email = v_email;
  if not found then
    return jsonb_build_object('status', 'none', 'access', get_company_access(p_company_id), 'can_cancel', false,
                              'payments', '[]'::jsonb);
  end if;

  -- Cortesia com prazo (0054): depois do prazo vale o que o Mercado Pago diz (sub_status).
  v_eff := billing_effective_status(b);
  v_prov := case when b.status = 'free' and b.courtesy_ends_at is not null
                      and v_eff not in ('courtesy', 'courtesy_ended') then 'mercadopago' else b.provider end;

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
    'status', case when v_eff in ('courtesy', 'courtesy_ended') then 'free' else v_eff end,
    'provider', v_prov,
    'courtesy_ends_at', b.courtesy_ends_at,
    'mp_status', b.mp_status,
    'amount', b.plan_amount,
    'currency', b.currency,
    'started_at', b.started_at,
    'trial_ends_at', case when b.provider = 'trial' then b.trial_ends_at
                          when b.started_at is not null then b.started_at + interval '7 days' end,
    'next_payment_at', b.next_payment_at,
    'canceled_at', b.canceled_at,
    'access', get_company_access(p_company_id),
    'can_cancel', v_eff not in ('free', 'courtesy', 'courtesy_ended') and v_prov = 'mercadopago' and b.preapproval_id is not null
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
                                  currency, payer_id, started_at, canceled_at, mp_last_modified, sub_status)
    values (v_email, v_status, 'mercadopago', v_pre, (p ->> 'next_payment_at')::timestamptz, p ->> 'mp_status',
            (p ->> 'amount')::numeric, p ->> 'currency', p ->> 'payer_id', (p ->> 'date_created')::timestamptz,
            case when v_status = 'canceled' then v_mod end, v_mod, v_status);
    v_applied := true;
  -- Assinatura nova depois de cancelar tem last_modified mais novo; um aviso atrasado
  -- de uma assinatura antiga não sobrescreve a atual.
  elsif v_cur.mp_last_modified is null or v_mod >= v_cur.mp_last_modified then
    update billing_accounts set
      -- Cortesia nunca é rebaixada; a com prazo já vencida deixa de ser cortesia (0054).
      status           = case when status = 'free' and not (courtesy_ends_at is not null and courtesy_ends_at <= now())
                              then 'free' else v_status end,
      provider         = case when status = 'free' and not (courtesy_ends_at is not null and courtesy_ends_at <= now())
                              then provider else 'mercadopago' end,
      sub_status       = v_status,
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

-- Painel: a lista e a ficha passam a mostrar a cortesia vencida como "sem assinatura" (e a ativa como cortesia).
CREATE OR REPLACE FUNCTION public.admin_accounts_base()
 RETURNS TABLE(company_id uuid, company_name text, is_demo boolean, created_at timestamp with time zone, owner_id uuid, owner_name text, owner_email text, owner_last_sign_in timestamp with time zone, billing_status text, billing_provider text, next_payment_at timestamp with time zone, billing_updated_at timestamp with time zone, suspended boolean, appointments_count bigint, clients_count bigint, services_count bigint, last_activity_at timestamp with time zone, whatsapp_status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.id, c.name, coalesce(c.is_demo, false), c.created_at,
         o.user_id, o.full_name, o.email, o.last_sign_in_at,
         coalesce(case b.eff when 'courtesy' then 'free' when 'courtesy_ended' then 'none' else b.eff end, 'none'), b.provider, b.next_payment_at, b.updated_at,
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
    select bb.*,
           case when bb.status = 'free' and bb.courtesy_ends_at is not null
                then case when bb.courtesy_ends_at > now() then 'courtesy' else coalesce(bb.sub_status, 'courtesy_ended') end
                else bb.status end as eff
    from company_members m join auth.users u on u.id = m.user_id join billing_accounts bb on bb.email = lower(u.email)
    where m.company_id = c.id and m.role = 'owner' and m.active
    order by array_position(array['free', 'courtesy', 'active', 'trialing', 'past_due', 'pending', 'canceled', 'courtesy_ended'], (case when bb.status = 'free' and bb.courtesy_ends_at is not null then case when bb.courtesy_ends_at > now() then 'courtesy' else coalesce(bb.sub_status, 'courtesy_ended') end else bb.status end)) limit 1
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
    'billing', (select jsonb_build_object('status', b.status, 'effective_status', billing_effective_status(b), 'courtesy_ends_at', b.courtesy_ends_at, 'provider', b.provider, 'preapproval_id', b.preapproval_id,
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

-- ---------------------------------------------------------------------------
-- Funções do painel (superadmin + verificação em duas etapas)
-- ---------------------------------------------------------------------------
create or replace function admin_courtesy_grant(p_email text, p_name text, p_days integer, p_origin text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_ends   timestamptz;
  v_cur    billing_accounts;
  v_found  boolean;
  v_company uuid;
  v_id     uuid;
  v_has_account boolean;
begin
  perform admin_assert();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if p_days is null or p_days < 1 or p_days > 365 then raise exception 'O prazo vai de 1 a 365 dias.' using errcode = '22023'; end if;
  if p_origin is null or p_origin not in ('parceria', 'indicacao', 'outro') then raise exception 'Origem inválida.' using errcode = '22023'; end if;
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'Informe o motivo (de 5 a 500 caracteres).' using errcode = '22023';
  end if;
  if v_name is not null and char_length(v_name) > 120 then raise exception 'Nome muito longo.' using errcode = '22023'; end if;

  -- até o fim do dia (Brasília) do último dia do prazo
  v_ends := ((date_trunc('day', now() at time zone 'America/Sao_Paulo') + p_days * interval '1 day' + interval '1 day' - interval '1 second')
             at time zone 'America/Sao_Paulo');

  select * into v_cur from billing_accounts where email = v_email for update;
  v_found := found;
  if v_found then
    if v_cur.status in ('active', 'past_due') then
      raise exception 'Esta pessoa já tem assinatura ativa. Não precisa de cortesia.' using errcode = 'ACG01';
    end if;
    if v_cur.status = 'pending' then
      raise exception 'Há uma assinatura em análise no Mercado Pago. Espere a confirmação.' using errcode = 'ACG02';
    end if;
    if v_cur.status = 'free' and v_cur.courtesy_ends_at is not null and v_cur.courtesy_ends_at > now() then
      raise exception 'Já existe uma cortesia ativa para este e-mail. Use "Estender".' using errcode = 'ACG03';
    end if;
  end if;

  select m.company_id into v_company from company_members m join auth.users u on u.id = m.user_id
  where lower(u.email) = v_email and m.role = 'owner' and m.active order by m.created_at limit 1;

  if not v_found then
    insert into billing_accounts (email, status, provider, started_at, courtesy_ends_at)
    values (v_email, 'free', 'cortesia', now(), v_ends);
  else
    update billing_accounts set
      status = 'free', provider = 'cortesia', courtesy_ends_at = v_ends,
      -- o que valia antes volta no fim da cortesia, se for o caso (assinatura cancelada, por exemplo)
      sub_status = case when v_cur.provider = 'mercadopago' then v_cur.status else v_cur.sub_status end,
      trial_ends_at = null, updated_at = now()
    where email = v_email;
  end if;

  insert into billing_courtesies (email, company_id, name, origin, reason, days, ends_at, granted_by, prior_status, prior_provider)
  values (v_email, v_company, v_name, p_origin, v_reason, p_days, v_ends, auth.uid(),
          case when v_found then v_cur.status end, case when v_found then v_cur.provider end)
  returning id into v_id;

  v_has_account := exists (select 1 from auth.users u where lower(u.email) = v_email);
  perform admin_log('courtesy_grant', v_company, 'ok', v_reason,
                    jsonb_build_object('courtesy_id', v_id, 'email', v_email, 'days', p_days, 'origin', p_origin,
                                       'ends_at', v_ends, 'prior_status', case when v_found then v_cur.status end));
  return jsonb_build_object('courtesy_id', v_id, 'ends_at', v_ends, 'has_account', v_has_account, 'email', v_email);
end;
$$;

create or replace function admin_courtesy_extend(p_courtesy_id uuid, p_days integer, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  c billing_courtesies;
  v_new timestamptz;
  v_bill billing_accounts;
begin
  perform admin_assert();
  if p_days is null or p_days < 1 or p_days > 365 then raise exception 'O prazo vai de 1 a 365 dias.' using errcode = '22023'; end if;
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'Informe o motivo (de 5 a 500 caracteres).' using errcode = '22023';
  end if;
  select * into c from billing_courtesies where id = p_courtesy_id for update;
  if not found then raise exception 'Cortesia não encontrada.' using errcode = 'P0002'; end if;
  if c.revoked_at is not null then raise exception 'Esta cortesia foi encerrada. Crie uma nova.' using errcode = 'ACG04'; end if;
  select * into v_bill from billing_accounts where email = c.email for update;
  if not found or v_bill.status <> 'free' or v_bill.provider <> 'cortesia' then
    raise exception 'Esta conta já não está em cortesia.' using errcode = 'ACG05';
  end if;
  -- ainda valendo: soma ao fim atual; já vencida: conta a partir de hoje
  if c.ends_at > now() then
    v_new := c.ends_at + p_days * interval '1 day';
  else
    v_new := ((date_trunc('day', now() at time zone 'America/Sao_Paulo') + p_days * interval '1 day' + interval '1 day' - interval '1 second')
              at time zone 'America/Sao_Paulo');
  end if;
  update billing_courtesies set ends_at = v_new, extensions = extensions + 1 where id = c.id;
  update billing_accounts set courtesy_ends_at = v_new, updated_at = now() where email = c.email;
  perform admin_log('courtesy_extend', c.company_id, 'ok', v_reason,
                    jsonb_build_object('courtesy_id', c.id, 'email', c.email, 'days', p_days, 'from', c.ends_at, 'to', v_new));
  return jsonb_build_object('courtesy_id', c.id, 'ends_at', v_new);
end;
$$;

create or replace function admin_courtesy_revoke(p_courtesy_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  c billing_courtesies;
begin
  perform admin_assert();
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'Informe o motivo (de 5 a 500 caracteres).' using errcode = '22023';
  end if;
  select * into c from billing_courtesies where id = p_courtesy_id for update;
  if not found then raise exception 'Cortesia não encontrada.' using errcode = 'P0002'; end if;
  if c.revoked_at is not null then raise exception 'Esta cortesia já foi encerrada.' using errcode = 'ACG04'; end if;
  update billing_courtesies set revoked_at = now(), revoked_by = auth.uid(), revoked_reason = v_reason,
         ends_at = least(ends_at, now()) where id = c.id;
  update billing_accounts set courtesy_ends_at = least(coalesce(courtesy_ends_at, now()), now()), updated_at = now()
  where email = c.email and status = 'free' and provider = 'cortesia';
  perform admin_log('courtesy_revoke', c.company_id, 'ok', v_reason,
                    jsonb_build_object('courtesy_id', c.id, 'email', c.email, 'was_ends_at', c.ends_at));
  return jsonb_build_object('courtesy_id', c.id, 'revoked', true);
end;
$$;

-- Lista para o painel: quem recebeu, até quando, quem concedeu, e se já virou assinatura.
create or replace function admin_list_courtesies(p_email text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_email text := nullif(lower(btrim(coalesce(p_email, ''))), ''); v jsonb;
begin
  perform admin_assert();
  select coalesce(jsonb_agg(x order by (x ->> 'granted_at') desc nulls last), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'id', c.id, 'email', c.email, 'name', c.name, 'origin', c.origin, 'reason', c.reason, 'days', c.days,
      'granted_at', c.granted_at, 'ends_at', c.ends_at, 'extensions', c.extensions, 'company_id', c.company_id,
      'granted_by', (select u.email from auth.users u where u.id = c.granted_by),
      'revoked_at', c.revoked_at, 'revoked_reason', c.revoked_reason,
      'has_account', exists (select 1 from auth.users u where lower(u.email) = c.email),
      'situation', case
        when c.revoked_at is not null then 'revogada'
        when c.ends_at <= now() then 'encerrada'
        when c.ends_at < now() + interval '7 days' then 'termina_em_breve'
        else 'ativa' end,
      'now_status', (select billing_effective_status(b) from billing_accounts b where b.email = c.email)
    ) as x
    from billing_courtesies c
    where v_email is null or c.email = v_email
    union all
    -- cortesias antigas, sem prazo (anteriores à 0054)
    select jsonb_build_object(
      'id', null, 'email', b.email, 'name', null, 'origin', null, 'reason', null, 'days', null,
      'granted_at', null, 'ends_at', null, 'extensions', 0, 'company_id', null, 'granted_by', null,
      'revoked_at', null, 'revoked_reason', null,
      'has_account', exists (select 1 from auth.users u where lower(u.email) = b.email),
      'situation', 'sem_prazo', 'now_status', 'free')
    from billing_accounts b
    where b.status = 'free' and b.courtesy_ends_at is null
      and not exists (select 1 from billing_courtesies c where c.email = b.email)
      and (v_email is null or b.email = v_email)
  ) t;
  return v;
end;
$$;

revoke all on function admin_courtesy_grant(text, text, integer, text, text) from public, anon;
revoke all on function admin_courtesy_extend(uuid, integer, text) from public, anon;
revoke all on function admin_courtesy_revoke(uuid, text) from public, anon;
revoke all on function admin_list_courtesies(text) from public, anon;
grant execute on function admin_courtesy_grant(text, text, integer, text, text) to authenticated;
grant execute on function admin_courtesy_extend(uuid, integer, text) to authenticated;
grant execute on function admin_courtesy_revoke(uuid, text) to authenticated;
grant execute on function admin_list_courtesies(text) to authenticated;
