-- ---------------------------------------------------------------------------
-- 0037 — ASSINATURA: acesso pago (Mercado Pago) + cortesia das contas atuais
--   * billing_accounts: situação por E-MAIL da dona (o acesso vale para a empresa
--     dela e toda a equipe). Só funções do servidor gravam (sem policies).
--   * Cortesia PERMANENTE ('free') para as donas de: Diêne Silva Nails,
--     Ester Andrade Nail Designer e Tainá Sobrancílios. (Tainá Santos fica de fora,
--     de propósito: conta de teste do fluxo pago.)
--   * get_company_access(empresa): o app pergunta se pode usar.
--     Libera: free, trialing, active, past_due (com aviso). Bloqueia: sem assinatura,
--     pending, canceled. Dados NUNCA são apagados.
--   * billing_upsert(...): chamada só pela função mp-webhook (service_role).
-- Não altera login, senhas, agenda, financeiro, WhatsApp nem permissões.
-- ---------------------------------------------------------------------------
create table if not exists billing_accounts (
  email           text primary key check (email = lower(email)),
  status          text not null check (status in ('free', 'trialing', 'active', 'past_due', 'canceled', 'pending')),
  provider        text,
  preapproval_id  text,
  next_payment_at timestamptz,
  updated_at      timestamptz not null default now()
);
alter table billing_accounts enable row level security;
revoke all on billing_accounts from public, anon, authenticated;

insert into billing_accounts (email, status, provider)
select distinct lower(u.email), 'free', 'cortesia'
from auth.users u join company_members m on m.user_id = u.id join companies c on c.id = m.company_id
where m.role = 'owner' and c.name in ('Diêne Silva Nails', 'Ester Andrade Nail Designer', 'Tainá Sobrancílios')
on conflict (email) do update set status = 'free', provider = 'cortesia', updated_at = now();

create or replace function get_company_access(p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_status text;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  if not is_company_member(p_company_id) then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  select b.status into v_status
  from company_members m join auth.users u on u.id = m.user_id join billing_accounts b on b.email = lower(u.email)
  where m.company_id = p_company_id and m.role = 'owner' and m.active
  order by array_position(array['free', 'active', 'trialing', 'past_due', 'pending', 'canceled'], b.status) limit 1;
  v_status := coalesce(v_status, 'none');
  return jsonb_build_object('status', v_status, 'allowed', v_status in ('free', 'trialing', 'active', 'past_due'),
                            'warning', v_status = 'past_due');
end;
$$;
revoke all on function get_company_access(uuid) from public, anon;
grant execute on function get_company_access(uuid) to authenticated;

create or replace function billing_upsert(p_email text, p_status text, p_preapproval_id text, p_next_payment_at timestamptz)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_email is null or btrim(p_email) = '' or p_status not in ('trialing', 'active', 'past_due', 'canceled', 'pending') then
    raise exception 'Dados de assinatura inválidos.' using errcode = '22023';
  end if;
  insert into billing_accounts (email, status, provider, preapproval_id, next_payment_at)
  values (lower(btrim(p_email)), p_status, 'mercadopago', p_preapproval_id, p_next_payment_at)
  on conflict (email) do update
    set status = case when billing_accounts.status = 'free' then 'free' else excluded.status end,   -- cortesia nunca é rebaixada
        provider = case when billing_accounts.status = 'free' then billing_accounts.provider else 'mercadopago' end,
        preapproval_id = excluded.preapproval_id, next_payment_at = excluded.next_payment_at, updated_at = now();
  return (select status from billing_accounts where email = lower(btrim(p_email)));
end;
$$;
revoke all on function billing_upsert(text, text, text, timestamptz) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function billing_upsert(text, text, text, timestamptz) to service_role;
  end if;
end $$;

-- onboarding: antes de existir empresa, a própria usuária consulta a SUA situação
create or replace function get_my_access()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_status text;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select b.status into v_status from auth.users u join billing_accounts b on b.email = lower(u.email) where u.id = auth.uid();
  v_status := coalesce(v_status, 'none');
  return jsonb_build_object('status', v_status, 'allowed', v_status in ('free', 'trialing', 'active', 'past_due'), 'warning', v_status = 'past_due');
end;
$$;
revoke all on function get_my_access() from public, anon;
grant execute on function get_my_access() to authenticated;

notify pgrst, 'reload schema';
