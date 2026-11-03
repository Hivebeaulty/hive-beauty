-- ---------------------------------------------------------------------------
-- 0048 — Aviso no celular antes de cada atendimento (notificação push).
--
-- A profissional ativa os avisos no próprio aparelho (Configurações) e escolhe a antecedência:
-- 15 min, 30 min, 1 h, 2 h ou desligado. A Edge Function `push-appointment-alerts` roda a cada
-- minuto (pg_cron + pg_net, segredo no Vault), pega os avisos que chegaram na hora e envia o
-- Web Push (chaves VAPID nos segredos da função).
--
--   push_subscriptions : um aparelho inscrito (endpoint + chaves). Só service_role lê.
--   push_prefs         : antecedência escolhida por membro (null = desligado).
--   push_alert_log     : avisos já reservados, para não repetir (chave: atendimento + horário).
--
-- Regras do aviso (push_claim_due_alerts):
--   * só atendimentos 'agendado' ou 'confirmado' que ainda não começaram;
--   * vai para a profissional responsável (professional_member_id) que tenha aparelho inscrito;
--   * só se o horário do aviso (início − antecedência) chegou nos últimos 15 minutos: depois de
--     uma pausa do sistema ou de um agendamento em cima da hora, não chega aviso atrasado;
--   * remarcar o atendimento gera um aviso novo (a chave inclui o horário).
-- Tudo é idempotente: rodar de novo não duplica nada. Nenhum dado existente é alterado.
-- ---------------------------------------------------------------------------

create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth_key     text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);
alter table push_subscriptions enable row level security;
revoke all on push_subscriptions from public, anon, authenticated;

create table if not exists push_prefs (
  member_id                 uuid primary key references company_members(id) on delete cascade,
  appointment_alert_minutes integer
    check (appointment_alert_minutes is null or appointment_alert_minutes between 5 and 1440),
  updated_at                timestamptz not null default now()
);
alter table push_prefs enable row level security;
revoke all on push_prefs from public, anon, authenticated;

create table if not exists push_alert_log (
  appointment_id  uuid not null references appointments(id) on delete cascade,
  scheduled_start timestamptz not null,
  minutes         integer not null,
  sent_at         timestamptz not null default now(),
  primary key (appointment_id, scheduled_start)
);
alter table push_alert_log enable row level security;
revoke all on push_alert_log from public, anon, authenticated;

-- --- Chamadas da profissional (sessão logada) ------------------------------------------------

create or replace function push_save_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if coalesce(length(p_endpoint), 0) < 20 or coalesce(length(p_p256dh), 0) < 20 or coalesce(length(p_auth), 0) < 8 then
    raise exception 'Inscrição inválida';
  end if;
  -- Mesmo aparelho em outra conta: o endpoint passa a valer para quem acabou de ativar.
  insert into push_subscriptions (user_id, endpoint, p256dh, auth_key, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 200))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth_key = excluded.auth_key,
        user_agent = excluded.user_agent, last_seen_at = now();
end;
$$;

create or replace function push_remove_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

create or replace function push_get_alert_minutes(p_member_id uuid)
returns integer language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v integer;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not exists (select 1 from company_members m where m.id = p_member_id and m.user_id = auth.uid() and m.active) then
    raise exception 'Sem permissão';
  end if;
  select pp.appointment_alert_minutes into v from push_prefs pp where pp.member_id = p_member_id;
  return v;
end;
$$;

create or replace function push_set_alert_minutes(p_member_id uuid, p_minutes integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not exists (select 1 from company_members m where m.id = p_member_id and m.user_id = auth.uid() and m.active) then
    raise exception 'Sem permissão';
  end if;
  if p_minutes is not null and (p_minutes < 5 or p_minutes > 1440) then
    raise exception 'Antecedência inválida';
  end if;
  insert into push_prefs (member_id, appointment_alert_minutes, updated_at)
  values (p_member_id, p_minutes, now())
  on conflict (member_id) do update set appointment_alert_minutes = excluded.appointment_alert_minutes, updated_at = now();
end;
$$;

-- --- Chamadas da Edge Function (service_role) -------------------------------------------------

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute $v$
      select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'push_alerts_cron',
                                 'Chamada do pg_cron para a função push-appointment-alerts')
      where not exists (select 1 from vault.secrets where name = 'push_alerts_cron')
    $v$;
  end if;
end $$;

create or replace function push_cron_secret_ok(p_secret text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  if p_secret is null or length(p_secret) < 32 then return false; end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = 'push_alerts_cron';
  return v is not null and v = p_secret;
end;
$$;

-- Reserva (na mesma instrução) os avisos que chegaram na hora e devolve o que enviar, com os
-- aparelhos da profissional. Duas execuções ao mesmo tempo não reservam o mesmo aviso.
create or replace function push_claim_due_alerts()
returns table (alert_appointment_id uuid, alert_start timestamptz, alert_minutes integer,
               client_name text, service_name text, subs jsonb)
language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select a.id as appt_id, a.scheduled_start as start_at, pp.appointment_alert_minutes as mins,
           c.name as cname, s.name as sname, m.user_id as uid
    from appointments a
    join company_members m on m.id = a.professional_member_id and m.active
    join push_prefs pp on pp.member_id = m.id and pp.appointment_alert_minutes is not null
    join companies co on co.id = a.company_id and co.status <> 'inativa'
    left join clients c on c.id = a.client_id
    left join services s on s.id = a.service_id
    where a.status in ('agendado', 'confirmado')
      and a.scheduled_start > now()
      and a.scheduled_start - make_interval(mins => pp.appointment_alert_minutes) <= now()
      and a.scheduled_start - make_interval(mins => pp.appointment_alert_minutes) > now() - interval '15 minutes'
      and exists (select 1 from push_subscriptions ps where ps.user_id = m.user_id)
      and not exists (select 1 from push_alert_log l where l.appointment_id = a.id and l.scheduled_start = a.scheduled_start)
  ), claimed as (
    insert into push_alert_log (appointment_id, scheduled_start, minutes)
    select appt_id, start_at, mins from due
    on conflict do nothing
    returning appointment_id, scheduled_start
  )
  select d.appt_id, d.start_at, d.mins,
         coalesce(d.cname, 'Cliente'), coalesce(d.sname, 'Atendimento'),
         (select jsonb_agg(jsonb_build_object('id', ps.id, 'endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth_key', ps.auth_key))
            from push_subscriptions ps where ps.user_id = d.uid)
  from due d
  join claimed k on k.appointment_id = d.appt_id and k.scheduled_start = d.start_at;
$$;

-- Aparelho que o serviço de push recusou (404/410): sai da lista.
create or replace function push_drop_subscriptions(p_ids uuid[])
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from push_subscriptions where id = any (coalesce(p_ids, '{}'));
$$;

revoke all on function push_save_subscription(text, text, text, text) from public, anon, authenticated;
revoke all on function push_remove_subscription(text) from public, anon, authenticated;
revoke all on function push_get_alert_minutes(uuid) from public, anon, authenticated;
revoke all on function push_set_alert_minutes(uuid, integer) from public, anon, authenticated;
revoke all on function push_cron_secret_ok(text) from public, anon, authenticated;
revoke all on function push_claim_due_alerts() from public, anon, authenticated;
revoke all on function push_drop_subscriptions(uuid[]) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function push_save_subscription(text, text, text, text) to authenticated;
    grant execute on function push_remove_subscription(text) to authenticated;
    grant execute on function push_get_alert_minutes(uuid) to authenticated;
    grant execute on function push_set_alert_minutes(uuid, integer) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function push_cron_secret_ok(text) to service_role;
    grant execute on function push_claim_due_alerts() to service_role;
    grant execute on function push_drop_subscriptions(uuid[]) to service_role;
  end if;
end $$;

-- A cada minuto (o aviso de 15 min precisa chegar perto dos 15 min, não até 5 min depois).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from pg_namespace where nspname = 'vault') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'aurea-push-alerts';
    perform cron.schedule('aurea-push-alerts', '* * * * *', $job$
      select net.http_post(
        url := 'https://hsdrndcnqcqqgbloqozy.supabase.co/functions/v1/push-appointment-alerts',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_alerts_cron')),
        body := '{}'::jsonb,
        timeout_milliseconds := 25000);
    $job$);
  end if;
end $$;
