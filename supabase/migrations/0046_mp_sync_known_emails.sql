-- ---------------------------------------------------------------------------
-- 0046 — mp-sync: assinatura que JÁ tem dona não pode virar "sem dona".
--
-- Falso alarme de 25/10/2026: a assinatura de teste da Tainá mudou no Mercado Pago
-- (valor alterado). A mp-sync voltou a processá-la; o Mercado Pago não informa o
-- e-mail, e as candidatas da busca (0044/0045) excluem quem já tem acesso. Resultado:
-- a assinatura foi marcada como sem dona e o suporte recebeu um alerta indevido.
-- Agora, antes de qualquer busca, a mp-sync usa o e-mail da conta já ligada àquela
-- assinatura (billing_accounts, e na falta dela o histórico billing_subscription_events).
-- Só service_role. Nenhum dado é apagado.
-- ---------------------------------------------------------------------------

create or replace function mp_sync_known_emails(p_ids text[])
returns table (preapproval_id text, email text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (k.preapproval_id) k.preapproval_id, k.email
  from (
    select b.preapproval_id, b.email, 0 as prio, b.updated_at as at
    from billing_accounts b where b.preapproval_id = any (coalesce(p_ids, '{}'))
    union all
    select e.preapproval_id, e.email, 1, e.occurred_at
    from billing_subscription_events e where e.preapproval_id = any (coalesce(p_ids, '{}'))
  ) k
  where k.email is not null and k.email <> ''
  order by k.preapproval_id, k.prio, k.at desc;
$$;

revoke all on function mp_sync_known_emails(text[]) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function mp_sync_known_emails(text[]) to service_role;
  end if;
end $$;
