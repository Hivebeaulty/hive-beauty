-- ---------------------------------------------------------------------------
-- 0052 — TESTE GRÁTIS SEM CARTÃO
--   A conta passa a nascer no próprio app (/cadastro), sem passar pelo Mercado
--   Pago: 7 dias de teste, sem cartão. No fim, a dona assina no Mercado Pago (o
--   mesmo link de sempre) com o mesmo e-mail; billing_sync atualiza a MESMA linha
--   de billing_accounts e o acesso passa a seguir a assinatura.
--   * billing_accounts.trial_ends_at: fim do teste sem cartão (provider 'trial').
--   * billing_start_trial(e-mail, ip): reserva o teste. Só para quem ainda não tem
--     login nem linha de assinatura (ninguém ganha teste de novo nem sobrescreve
--     cortesia ou assinatura). No máximo 5 cadastros por hora vindos do mesmo IP.
--   * billing_trial_release(e-mail): desfaz a reserva se a criação do login falhar.
--   * get_company_access / get_my_access: teste sem cartão libera até
--     trial_ends_at (aviso nos últimos 3 dias); depois, 'trial_ended' (sem acesso).
--   * my_subscription: mostra o fim do teste sem cartão.
-- Contas do Mercado Pago, cortesias e o acesso de quem já usa não mudam.
-- ---------------------------------------------------------------------------

alter table billing_accounts add column if not exists trial_ends_at timestamptz;

create table if not exists trial_signups (
  id         bigint generated always as identity primary key,
  email      text not null check (email = lower(email)),
  ip_hash    text,
  created_at timestamptz not null default now()
);
create index if not exists trial_signups_ip_idx on trial_signups (ip_hash, created_at desc);
alter table trial_signups enable row level security;
revoke all on trial_signups from public, anon, authenticated;

create or replace function billing_start_trial(p_email text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_ip    text := nullif(btrim(coalesce(p_ip_hash, '')), '');
  v_until timestamptz := now() + interval '7 days';
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'E-mail inválido.' using errcode = '22023';
  end if;
  if v_ip is not null and (select count(*) from trial_signups t
                           where t.ip_hash = v_ip and t.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Muitos cadastros seguidos deste aparelho. Tente de novo mais tarde.' using errcode = '54000';
  end if;
  -- Já tem login (dona, equipe convidada) ou já teve assinatura/teste/cortesia: não ganha teste novo.
  if exists (select 1 from auth.users u where lower(u.email) = v_email)
     or exists (select 1 from billing_accounts b where b.email = v_email) then
    raise exception 'Este e-mail já tem conta na Sócia. Entre com a sua senha.' using errcode = '23505';
  end if;
  insert into billing_accounts (email, status, provider, started_at, trial_ends_at)
  values (v_email, 'trialing', 'trial', now(), v_until);
  insert into trial_signups (email, ip_hash) values (v_email, v_ip);
  return jsonb_build_object('trial_ends_at', v_until);
end;
$$;

-- Desfaz a reserva quando a criação do login falha (só se ainda for teste sem cartão e sem login).
create or replace function billing_trial_release(p_email text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from billing_accounts b
  where b.email = lower(btrim(coalesce(p_email, ''))) and b.provider = 'trial'
    and not exists (select 1 from auth.users u where lower(u.email) = b.email);
end;
$$;

revoke all on function billing_start_trial(text, text) from public, anon, authenticated;
revoke all on function billing_trial_release(text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function billing_start_trial(text, text) to service_role;
    grant execute on function billing_trial_release(text) to service_role;
  end if;
end $$;

-- Acesso da empresa: igual à 0041, mais o teste sem cartão.
create or replace function get_company_access(p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
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
$$;

-- Acesso antes de existir empresa (onboarding): igual à 0037, mais o teste sem cartão.
create or replace function get_my_access()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
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
$$;

-- Assinatura vista pela dona: igual à 0051, com o fim do teste sem cartão.
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
$$;

revoke all on function get_company_access(uuid) from public, anon;
grant execute on function get_company_access(uuid) to authenticated;
revoke all on function get_my_access() from public, anon;
grant execute on function get_my_access() to authenticated;
revoke all on function my_subscription(uuid) from public, anon;
grant execute on function my_subscription(uuid) to authenticated;

notify pgrst, 'reload schema';
