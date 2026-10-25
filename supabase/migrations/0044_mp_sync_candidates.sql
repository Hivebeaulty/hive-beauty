-- ---------------------------------------------------------------------------
-- 0044 — mp-sync: e-mail da pagadora quando o Mercado Pago não o devolve.
--
-- Assinaturas feitas por link de plano vêm com payer_email vazio. A busca do Mercado
-- Pago aceita o filtro payer_email (verificado em produção em 25/10/2026: o e-mail da
-- pagadora encontra a assinatura; um e-mail inexistente não encontra nada). A mp-sync
-- consulta, para cada candidata desta lista, quais assinaturas são dela, e só liga a
-- assinatura a um e-mail confirmado pelo próprio Mercado Pago.
-- Candidatas: contas da Áurea sem acesso por assinatura (sem conta de cobrança ou com
-- situação que não libera), criadas nos últimos 90 dias. Só service_role.
-- ---------------------------------------------------------------------------

create or replace function mp_sync_candidates()
returns setof text language sql stable security definer set search_path = public, pg_temp as $$
  select lower(u.email)
  from auth.users u
  left join billing_accounts b on b.email = lower(u.email)
  where u.email is not null
    and u.created_at > now() - interval '90 days'
    and (b.email is null or b.status not in ('free', 'trialing', 'active', 'past_due'))
  order by u.created_at desc
  limit 50;
$$;
revoke all on function mp_sync_candidates() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function mp_sync_candidates() to service_role;
  end if;
end $$;
