-- ---------------------------------------------------------------------------
-- 0042 — E-mails da assinatura: boas-vindas e aviso antes da primeira cobrança.
--
-- A cada 15 minutos o pg_cron chama a Edge Function `billing-emails` (via pg_net),
-- com um segredo gerado aqui e guardado no Vault (ninguém precisa conhecê-lo).
-- A função pede as listas a billing_email_targets(), "reserva" cada envio com
-- billing_email_claim() (nunca dois iguais) e registra o resultado com
-- billing_email_finish(). Erro do provedor: nova tentativa no ciclo seguinte, até 5.
--
--   welcome       assinatura do Mercado Pago que começou (teste ou ativa) nos últimos
--                 7 dias e ainda não recebeu as boas-vindas.
--   trial_ending  em teste, com a primeira cobrança entre 12 h e 52 h à frente
--                 (≈ 5º dia do teste), enviado só entre 9h e 20h (Brasília).
-- Cortesias (provider 'manual') e contas antigas não entram.
-- Tudo só para service_role. Nenhum dado é apagado.
-- ---------------------------------------------------------------------------

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end $$;

create table if not exists billing_emails (
  id                  bigint generated always as identity primary key,
  kind                text not null check (kind in ('welcome', 'trial_ending')),
  preapproval_id      text not null,
  email               text not null,
  status              text not null default 'sending' check (status in ('sending', 'sent', 'error')),
  attempts            int not null default 1,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (kind, preapproval_id)
);
alter table billing_emails enable row level security;
revoke all on billing_emails from public, anon, authenticated;

-- Segredo da chamada do pg_cron (criado uma vez, dentro do Vault).
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute $v$
      select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'billing_emails_cron',
                                 'Chamada do pg_cron para a função billing-emails')
      where not exists (select 1 from vault.secrets where name = 'billing_emails_cron')
    $v$;
  end if;
end $$;

create or replace function billing_emails_secret_ok(p_secret text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  if p_secret is null or length(p_secret) < 32 then return false; end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = 'billing_emails_cron';
  return v is not null and v = p_secret;
end;
$$;

-- Listas do ciclo. p_now só existe para os testes; em produção é now().
create or replace function billing_email_targets(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'welcome', coalesce((
      select jsonb_agg(jsonb_build_object('preapproval_id', b.preapproval_id, 'email', b.email,
                                          'status', b.status, 'next_payment_at', b.next_payment_at,
                                          'amount', b.plan_amount) order by b.updated_at)
      from billing_accounts b
      where b.provider = 'mercadopago' and b.preapproval_id is not null
        and b.status in ('trialing', 'active')
        and coalesce(b.started_at, b.updated_at) > p_now - interval '7 days'
        and not exists (select 1 from billing_emails e where e.kind = 'welcome' and e.preapproval_id = b.preapproval_id
                          and (e.status = 'sent' or e.attempts >= 5
                               or (e.status = 'sending' and e.updated_at > p_now - interval '30 minutes')))), '[]'::jsonb),
    'trial_ending', coalesce((
      select jsonb_agg(jsonb_build_object('preapproval_id', b.preapproval_id, 'email', b.email,
                                          'next_payment_at', b.next_payment_at, 'amount', b.plan_amount) order by b.next_payment_at)
      from billing_accounts b
      where b.provider = 'mercadopago' and b.preapproval_id is not null and b.status = 'trialing'
        and b.next_payment_at > p_now + interval '12 hours' and b.next_payment_at <= p_now + interval '52 hours'
        and extract(hour from p_now at time zone 'America/Sao_Paulo') between 9 and 19
        and not exists (select 1 from billing_emails e where e.kind = 'trial_ending' and e.preapproval_id = b.preapproval_id
                          and (e.status = 'sent' or e.attempts >= 5
                               or (e.status = 'sending' and e.updated_at > p_now - interval '30 minutes')))), '[]'::jsonb)
  );
$$;

-- Reserva o envio. Devolve o id da reserva, ou null se já foi enviado (ou está saindo).
create or replace function billing_email_claim(p_kind text, p_preapproval_id text, p_email text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  if p_kind not in ('welcome', 'trial_ending') or coalesce(p_preapproval_id, '') = '' or coalesce(p_email, '') !~ '@' then
    raise exception 'Envio inválido.' using errcode = '22023';
  end if;
  insert into billing_emails (kind, preapproval_id, email) values (p_kind, p_preapproval_id, lower(p_email))
  on conflict (kind, preapproval_id) do update
    set status = 'sending', attempts = billing_emails.attempts + 1, error = null, updated_at = now(), email = excluded.email
    where billing_emails.attempts < 5
      and (billing_emails.status = 'error'
           or (billing_emails.status = 'sending' and billing_emails.updated_at < now() - interval '30 minutes'))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function billing_email_finish(p_id bigint, p_ok boolean, p_message_id text, p_error text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update billing_emails
     set status = case when p_ok then 'sent' else 'error' end,
         provider_message_id = left(p_message_id, 200), error = left(p_error, 500), updated_at = now()
   where id = p_id and status = 'sending';
$$;

revoke all on function billing_emails_secret_ok(text) from public, anon, authenticated;
revoke all on function billing_email_targets(timestamptz) from public, anon, authenticated;
revoke all on function billing_email_claim(text, text, text) from public, anon, authenticated;
revoke all on function billing_email_finish(bigint, boolean, text, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function billing_emails_secret_ok(text) to service_role;
    grant execute on function billing_email_targets(timestamptz) to service_role;
    grant execute on function billing_email_claim(text, text, text) to service_role;
    grant execute on function billing_email_finish(bigint, boolean, text, text) to service_role;
  end if;
end $$;

-- Agendamento: a cada 15 minutos (só em produção, onde existem pg_cron, pg_net e Vault).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from pg_namespace where nspname = 'vault') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'aurea-billing-emails';
    perform cron.schedule('aurea-billing-emails', '*/15 * * * *', $job$
      select net.http_post(
        url := 'https://hsdrndcnqcqqgbloqozy.supabase.co/functions/v1/billing-emails',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'billing_emails_cron')),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000);
    $job$);
  end if;
end $$;
