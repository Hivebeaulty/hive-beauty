-- ---------------------------------------------------------------------------
-- 0056 — LEMBRETE NO CELULAR DOS COMPROMISSOS DA AGENDA (bloqueios de horário)
--
-- O bloqueio de horário (folga, almoço, consulta, compromisso pessoal; tabela blocked_times, 0001)
-- passa a poder avisar no celular da profissional, com antecedência, pelo MESMO caminho do aviso
-- de atendimento (0048): pg_cron chama a Edge Function `push-appointment-alerts` a cada minuto e
-- ela envia o Web Push aos aparelhos inscritos. Nada muda no aviso de atendimento.
--
--   blocked_times.remind_before_minutes : quando avisar, em minutos ANTES do início do bloqueio.
--       null = sem lembrete (padrão: tudo que já existe continua igual).
--       Horário:  0 (no horário), 15, 30, 60, 120, 1440 (1 dia antes).
--       Dia todo: o início é a meia-noite, então usa-se 360 (véspera às 18h) e -480 (no dia, às 8h).
--       Faixa aceita: -1440 a 10080 (7 dias).
--   push_block_alert_log : lembretes já reservados, para não repetir (chave: bloqueio + horário do aviso).
--       Mudar o horário do bloqueio gera um aviso novo; mudar só a observação, não.
--
-- Quem recebe: a profissional do bloqueio; se o bloqueio é da equipe toda (professional_member_id nulo),
-- todos os membros ativos da empresa. Só chega a quem tem aparelho inscrito (Configurações → Avisos no
-- celular). Mesmas regras do 0048: só se o horário do aviso chegou nos últimos 15 minutos (nada de aviso
-- atrasado depois de uma pausa) e o compromisso ainda não terminou; empresa inativa não recebe.
-- Se ninguém do bloqueio tem aparelho, o aviso NÃO é reservado: quem inscrever o aparelho a tempo ainda recebe.
--
-- Idempotente; não altera dados nem políticas existentes. A gravação do lembrete usa a política que
-- já vale para blocked_times (membros da empresa), como o resto do bloqueio.
-- ---------------------------------------------------------------------------

alter table blocked_times add column if not exists remind_before_minutes integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'blocked_times_remind_range') then
    alter table blocked_times
      add constraint blocked_times_remind_range
      check (remind_before_minutes is null or remind_before_minutes between -1440 and 10080);
  end if;
end $$;

create table if not exists push_block_alert_log (
  block_id  uuid not null references blocked_times(id) on delete cascade,
  remind_at timestamptz not null,
  sent_at   timestamptz not null default now(),
  primary key (block_id, remind_at)
);
alter table push_block_alert_log enable row level security;
revoke all on push_block_alert_log from public, anon, authenticated;

-- Reserva (na mesma instrução) os lembretes que chegaram na hora e devolve o que enviar, já com os
-- aparelhos de quem deve receber. Duas execuções ao mesmo tempo não reservam o mesmo lembrete.
-- alert_all_day: o bloqueio começa e termina à meia-noite de Brasília (mesmo relógio da agenda).
create or replace function push_claim_due_block_reminders()
returns table (alert_block_id uuid, alert_remind_at timestamptz, alert_start timestamptz, alert_end timestamptz,
               alert_all_day boolean, alert_reason text, alert_before integer, subs jsonb)
language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select b.id as block_id, b.company_id, b.professional_member_id as prof_id,
           b.start_at, b.end_at, b.reason, b.remind_before_minutes as before_min,
           b.start_at - make_interval(mins => b.remind_before_minutes) as remind_at,
           ((b.start_at at time zone 'America/Sao_Paulo')::time = time '00:00'
            and (b.end_at at time zone 'America/Sao_Paulo')::time = time '00:00') as all_day
    from blocked_times b
    join companies co on co.id = b.company_id and co.status <> 'inativa'
    where b.remind_before_minutes is not null
      and b.end_at > now()
      and b.start_at - make_interval(mins => b.remind_before_minutes) <= now()
      and b.start_at - make_interval(mins => b.remind_before_minutes) > now() - interval '15 minutes'
      and not exists (
        select 1 from push_block_alert_log l
        where l.block_id = b.id and l.remind_at = b.start_at - make_interval(mins => b.remind_before_minutes))
  ), devices as (
    select d.block_id, ps.id as sub_id, ps.endpoint, ps.p256dh, ps.auth_key
    from due d
    join company_members m on m.company_id = d.company_id and m.active
                          and (d.prof_id is null or m.id = d.prof_id)
    join push_subscriptions ps on ps.user_id = m.user_id
  ), claimed as (
    insert into push_block_alert_log (block_id, remind_at)
    select d.block_id, d.remind_at from due d
    where exists (select 1 from devices v where v.block_id = d.block_id)
    on conflict do nothing
    returning block_id, remind_at
  )
  select d.block_id, d.remind_at, d.start_at, d.end_at, d.all_day, d.reason, d.before_min,
         (select jsonb_agg(jsonb_build_object('id', x.sub_id, 'endpoint', x.endpoint, 'p256dh', x.p256dh, 'auth_key', x.auth_key))
            from (select distinct v.sub_id, v.endpoint, v.p256dh, v.auth_key from devices v where v.block_id = d.block_id) x)
  from due d
  join claimed k on k.block_id = d.block_id and k.remind_at = d.remind_at;
$$;

revoke all on function push_claim_due_block_reminders() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function push_claim_due_block_reminders() to service_role;
  end if;
end $$;
