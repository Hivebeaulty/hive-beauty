-- ---------------------------------------------------------------------------
-- 0043 — Sincronização com o Mercado Pago sem depender do webhook.
--
-- Incidente de 25/10/2026: uma assinatura real (link de plano criado no painel do
-- Mercado Pago) não disparou o webhook da aplicação; a conta não foi liberada.
-- A Edge Function `mp-sync` (a cada 5 min, pg_cron + pg_net, segredo no Vault) lista
-- as assinaturas no Mercado Pago e processa as novas ou alteradas como a mp-webhook.
-- mp_sync_seen guarda a última alteração processada de cada assinatura.
-- Tudo só para service_role. Nenhum dado é apagado.
-- ---------------------------------------------------------------------------

create table if not exists mp_sync_seen (
  preapproval_id text primary key,
  last_modified  timestamptz,
  synced_at      timestamptz not null default now()
);
alter table mp_sync_seen enable row level security;
revoke all on mp_sync_seen from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute $v$
      select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'mp_sync_cron',
                                 'Chamada do pg_cron para a função mp-sync')
      where not exists (select 1 from vault.secrets where name = 'mp_sync_cron')
    $v$;
  end if;
end $$;

create or replace function mp_sync_secret_ok(p_secret text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  if p_secret is null or length(p_secret) < 32 then return false; end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = 'mp_sync_cron';
  return v is not null and v = p_secret;
end;
$$;

create or replace function mp_sync_known(p_ids text[])
returns table (id text, last_modified timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.preapproval_id, s.last_modified from mp_sync_seen s where s.preapproval_id = any (coalesce(p_ids, '{}'));
$$;

create or replace function mp_sync_mark(p_id text, p_last_modified timestamptz)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into mp_sync_seen (preapproval_id, last_modified) values (p_id, p_last_modified)
  on conflict (preapproval_id) do update
    set last_modified = greatest(mp_sync_seen.last_modified, excluded.last_modified), synced_at = now();
$$;

revoke all on function mp_sync_secret_ok(text) from public, anon, authenticated;
revoke all on function mp_sync_known(text[]) from public, anon, authenticated;
revoke all on function mp_sync_mark(text, timestamptz) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function mp_sync_secret_ok(text) to service_role;
    grant execute on function mp_sync_known(text[]) to service_role;
    grant execute on function mp_sync_mark(text, timestamptz) to service_role;
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from pg_namespace where nspname = 'vault') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'aurea-mp-sync';
    perform cron.schedule('aurea-mp-sync', '*/5 * * * *', $job$
      select net.http_post(
        url := 'https://hsdrndcnqcqqgbloqozy.supabase.co/functions/v1/mp-sync',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mp_sync_cron')),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000);
    $job$);
  end if;
end $$;
