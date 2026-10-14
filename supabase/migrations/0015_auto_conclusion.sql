-- ---------------------------------------------------------------------------
-- 0015 — Conclusão automática de atendimentos (DESLIGADA ao aplicar)
--
-- Regra de negócio aprovada:
--   * 5 minutos após o término previsto (scheduled_end), um atendimento em
--     aberto é concluído com UM recebimento 'pago' via Pix, origem 'auto',
--     datado do próprio atendimento (scheduled_end).
--   * A profissional corrige depois pelos recursos existentes (0012/0014):
--     trocar a forma, marcar pendente/recebido, "Cliente não compareceu".
--   * Nada de novo status, tela ou confirmação.
--
-- O que esta migration cria (tudo no schema PRIVADO aurea_private, que não é
-- exposto pela API e não é utilizável por anon/authenticated/service_role):
--   settings            uma linha: chave geral (desligada), tolerância, lote,
--                       tentativas e a data de início (process_from, gravada
--                       UMA vez na ativação e imutável depois)
--   runs / run_items    log de cada execução e de cada atendimento processado,
--                       com a "foto" usada pela reversão
--   appointment_state   controle por atendimento: tentativas, bloqueio, exclusão
--   regularize()        regularização tudo-ou-nada, com dry run, IDs e total
--   activate_auto_conclusion()  ativação única, amarrada a uma regularização
--                       efetivada no mesmo dia (São Paulo)
--   run_auto_conclusion()       ponto de entrada do cron (0016)
--   revert_run()        reversão estrita de uma execução
--
-- Também cria 3 índices em tabelas públicas (só desempenho).
-- NÃO altera dados, RLS, policies, funções ou gatilhos existentes (inclusive
-- as proteções da 0014) e NÃO agenda nada: o cron está na 0016.
-- ---------------------------------------------------------------------------

-- 0. PREFLIGHT -----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'payments' and column_name = 'source')
     or not exists (select 1 from pg_trigger where tgname = 'trg_appointments_guard_lifecycle')
     or not exists (select 1 from pg_trigger where tgname = 'trg_payments_appointment_consistency')
     or not exists (select 1 from pg_proc where proname = 'reclassify_appointment_as_no_show') then
    raise exception '0015 ABORTADA — nada foi alterado. Aplique antes a migration 0014.'
      using errcode = '55000';
  end if;
end $$;


-- 1. SCHEMA PRIVADO ---------------------------------------------------------------
create schema if not exists aurea_private;
revoke all on schema aurea_private from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema aurea_private from %I', r);
    end if;
  end loop;
end $$;
-- funções criadas daqui em diante neste schema não nascem executáveis por PUBLIC
alter default privileges in schema aurea_private revoke execute on functions from public;


-- 2. ÍNDICES (desempenho; tabelas públicas, nenhum dado alterado) -------------------
create index if not exists appointments_open_scheduled_end_idx
  on appointments (scheduled_end)
  where status in ('agendado', 'confirmado', 'em_atendimento');
create index if not exists audit_logs_entity_entity_id_idx
  on audit_logs (entity, entity_id);
create index if not exists appointment_status_history_appointment_id_idx
  on appointment_status_history (appointment_id);


-- 3. CONFIGURAÇÃO (uma linha) -----------------------------------------------------
create table if not exists aurea_private.settings (
  id               boolean primary key default true constraint settings_singleton check (id),
  enabled          boolean not null default false,
  grace            interval not null default interval '5 minutes'
                     constraint settings_grace_range check (grace >= interval '0' and grace <= interval '1 hour'),
  batch_limit      int not null default 200 constraint settings_batch_range check (batch_limit between 1 and 1000),
  max_attempts     int not null default 5 constraint settings_attempts_range check (max_attempts between 1 and 20),
  retry_interval   interval not null default interval '15 minutes'
                     constraint settings_retry_range check (retry_interval >= interval '1 minute'),
  process_from     timestamptz,
  activation_run_id uuid,
  activated_at     timestamptz,
  activated_by     text,
  last_run_at      timestamptz,
  last_run_status  text,
  last_run_id      uuid,
  constraint settings_enabled_requires_start check (not enabled or process_from is not null)
);
insert into aurea_private.settings (id) values (true) on conflict (id) do nothing;

-- process_from e os dados da ativação: gravados UMA vez, só pela função de
-- ativação, e imutáveis depois (para qualquer papel, inclusive o dono do banco).
-- A linha não pode ser apagada nem a tabela truncada. enabled e os dados de
-- "última execução" continuam alteráveis (chave geral / batimento).
create or replace function aurea_private.settings_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'A configuração da conclusão automática não pode ser apagada.' using errcode = '55000';
  end if;
  if (new.process_from, new.activation_run_id, new.activated_at, new.activated_by)
     is distinct from (old.process_from, old.activation_run_id, old.activated_at, old.activated_by) then
    if old.process_from is not null then
      raise exception 'A data de início da automação já foi gravada (%) e não pode ser alterada.', old.process_from
        using errcode = '55000';
    end if;
    if coalesce(current_setting('aurea_private.activating', true), '') <> 'on' then
      raise exception 'A data de início só pode ser gravada por aurea_private.activate_auto_conclusion().'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_settings_guard on aurea_private.settings;
create trigger trg_settings_guard
  before update or delete on aurea_private.settings
  for each row execute function aurea_private.settings_guard();
drop trigger if exists trg_settings_guard_truncate on aurea_private.settings;
create trigger trg_settings_guard_truncate
  before truncate on aurea_private.settings
  for each statement execute function aurea_private.settings_guard();


-- 4. LOG DE EXECUÇÕES E ITENS -------------------------------------------------------
create table if not exists aurea_private.runs (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('scheduled', 'regularization_dry_run', 'regularization',
                                                'revert_dry_run', 'revert')),
  status         text not null default 'running' check (status in ('running', 'ok', 'partial', 'aborted')),
  now_ref        timestamptz not null,     -- o "agora" usado
  cutoff         timestamptz,              -- automação: agora - tolerância; regularização: 00:00 SP do dia
  process_from   timestamptz,
  expected_ids   uuid[],
  expected_total numeric(12, 2),
  target_run_id  uuid references aurea_private.runs (id),  -- reversão: execução revertida
  selected       int not null default 0,
  concluded      int not null default 0,
  skipped        int not null default 0,
  failed         int not null default 0,
  total_amount   numeric(12, 2) not null default 0,
  message        text,
  executed_by    text not null default current_user,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create table if not exists aurea_private.run_items (
  seq                   bigint generated always as identity primary key,
  run_id                uuid not null references aurea_private.runs (id),
  appointment_id        uuid not null,            -- sem FK: o log sobrevive a exclusões
  company_id            uuid not null,
  client_id             uuid,
  outcome               text not null check (outcome in ('concluded', 'would_conclude', 'skipped', 'failed')),
  reason                text,
  amount                numeric(12, 2),
  payment_id            uuid,
  sqlstate              text,
  message               text,
  -- estado ANTERIOR (para restaurar na reversão)
  before_status         appointment_status,
  before_payment_method payment_method,
  before_completed_at   timestamptz,
  before_first_visit    date,
  before_last_visit     date,
  -- "foto" do estado DEPOIS (para detectar qualquer correção posterior)
  after_appt            jsonb,
  after_payment         jsonb,
  after_first_visit     date,
  after_last_visit      date,
  n_audit_appt          int,
  n_audit_payment       int,
  n_history             int,
  reverted_run_id       uuid references aurea_private.runs (id),
  created_at            timestamptz not null default now(),
  constraint run_items_once_per_run unique (run_id, appointment_id)
);
-- um atendimento só pode ter UMA conclusão automática na vida
create unique index if not exists run_items_concluded_once
  on aurea_private.run_items (appointment_id) where outcome = 'concluded';
create index if not exists run_items_run_id_idx on aurea_private.run_items (run_id);

create table if not exists aurea_private.appointment_state (
  appointment_id  uuid primary key,
  company_id      uuid not null,
  status          text not null check (status in ('anomaly', 'retry', 'blocked', 'excluded')),
  reason          text not null,
  attempts        int not null default 0,
  last_attempt_at timestamptz,
  last_sqlstate   text,
  last_message    text,
  updated_at      timestamptz not null default now()
);

-- defesa extra: RLS ligada e sem policies (só o dono das tabelas acessa)
alter table aurea_private.settings enable row level security;
alter table aurea_private.runs enable row level security;
alter table aurea_private.run_items enable row level security;
alter table aurea_private.appointment_state enable row level security;


-- 5. FUNÇÕES AUXILIARES ------------------------------------------------------------
-- 00:00 do dia, em São Paulo, do instante informado (independe do fuso da sessão)
create or replace function aurea_private.sp_day_start(p_at timestamptz)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select date_trunc('day', p_at at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'
$$;

-- Motivo pelo qual um atendimento NÃO pode ser concluído automaticamente
-- (NULL = pode). Única fonte da regra, usada na seleção E na rechecagem
-- depois de travar a linha.
create or replace function aurea_private.appointment_ineligibility(
  p_appointment_id uuid, p_cutoff timestamptz, p_process_from timestamptz)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then
    return 'missing';
  end if;
  if a.status not in ('agendado', 'confirmado', 'em_atendimento') then
    return 'status';
  end if;
  if a.scheduled_end > p_cutoff then
    return 'not_due';
  end if;
  if p_process_from is not null and a.scheduled_end < p_process_from then
    return 'out_of_window';
  end if;
  if a.price is null or a.price <= 0 then
    return 'price';
  end if;
  if exists (select 1 from payments p where p.appointment_id = a.id) then
    return 'has_payment';
  end if;
  -- já foi falta ou cancelado em QUALQUER momento (mesmo se reaberto depois):
  -- histórico de status (API só insere/lê) OU auditoria (API só lê)
  if exists (select 1 from appointment_status_history h
              where h.appointment_id = a.id and h.status in ('cancelado', 'nao_compareceu'))
     or exists (select 1 from audit_logs l
                 where l.entity = 'appointments' and l.entity_id = a.id
                   and (l.metadata -> 'after' ->> 'status') in ('cancelado', 'nao_compareceu')) then
    return 'history_cancel_or_no_show';
  end if;
  if exists (select 1 from aurea_private.appointment_state s
              where s.appointment_id = a.id and s.status in ('blocked', 'excluded')) then
    return 'state_' || (select s.status from aurea_private.appointment_state s where s.appointment_id = a.id);
  end if;
  return null;
end;
$$;


-- 6. NÚCLEO: conclui UM atendimento (usado pela automação e pela regularização) -----
-- Trava a linha (SKIP LOCKED: se a profissional estiver mexendo, fica para a
-- próxima), rechecagem completa, grava tudo e força NA HORA a invariante da
-- 0014 (concluído <=> recebimento), para que uma violação desfaça só este
-- atendimento. Grava a "foto" usada pela reversão. Nunca altera um recebimento
-- existente e nunca cria um segundo.
create or replace function aurea_private._conclude_one(
  p_appointment_id uuid, p_run_id uuid, p_source text,
  p_cutoff timestamptz, p_process_from timestamptz, p_dry_run boolean)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_reason text;
  v_payment_id uuid;
  v_day date;
  v_first date;
  v_last date;
begin
  if p_source not in ('auto', 'backfill') then
    raise exception 'Origem inválida: %', p_source using errcode = '22023';
  end if;

  select * into a from appointments where id = p_appointment_id for update skip locked;
  if not found then
    if exists (select 1 from appointments where id = p_appointment_id) then
      return 'locked';
    end if;
    return 'missing';
  end if;

  v_reason := aurea_private.appointment_ineligibility(a.id, p_cutoff, p_process_from);
  if v_reason is not null then
    return v_reason;
  end if;
  if p_dry_run then
    return 'would_conclude';
  end if;

  select first_visit_at, last_visit_at into v_first, v_last from clients where id = a.client_id for update;
  v_day := (a.scheduled_end at time zone 'America/Sao_Paulo')::date;

  set constraints all deferred;

  update appointments
  set status = 'concluido', payment_method = 'pix', completed_at = a.scheduled_end
  where id = a.id;

  insert into payments (company_id, appointment_id, client_id, amount, paid_amount, method, status,
                        paid_at, created_at, source)
  values (a.company_id, a.id, a.client_id, a.price, a.price, 'pix', 'pago',
          a.scheduled_end, a.scheduled_end, p_source)
  returning id into v_payment_id;

  update clients
  set first_visit_at = least(coalesce(first_visit_at, v_day), v_day),
      last_visit_at  = greatest(coalesce(last_visit_at, v_day), v_day)
  where id = a.client_id;

  update appointment_status_history
  set note = case p_source
               when 'auto' then format('Concluído automaticamente após o término previsto; recebimento Pix registrado (execução %s).',
                                       p_run_id)
               else format('Regularização: concluído com recebimento Pix (execução %s).', p_run_id)
             end
  where id = (select h.id from appointment_status_history h
               where h.appointment_id = a.id and h.status = 'concluido'
               order by h.changed_at desc limit 1);

  -- a invariante da 0014 é verificada AGORA, dentro do bloco deste atendimento
  set constraints all immediate;

  insert into aurea_private.run_items (
    run_id, appointment_id, company_id, client_id, outcome, amount, payment_id,
    before_status, before_payment_method, before_completed_at, before_first_visit, before_last_visit,
    after_appt, after_payment, after_first_visit, after_last_visit,
    n_audit_appt, n_audit_payment, n_history)
  select p_run_id, a.id, a.company_id, a.client_id, 'concluded', a.price, v_payment_id,
         a.status, a.payment_method, a.completed_at, v_first, v_last,
         (select to_jsonb(x) from appointments x where x.id = a.id),
         (select to_jsonb(y) from payments y where y.id = v_payment_id),
         c.first_visit_at, c.last_visit_at,
         (select count(*) from audit_logs l where l.entity = 'appointments' and l.entity_id = a.id),
         (select count(*) from audit_logs l where l.entity = 'payments' and l.entity_id = v_payment_id),
         (select count(*) from appointment_status_history h where h.appointment_id = a.id)
  from clients c where c.id = a.client_id;

  delete from aurea_private.appointment_state where appointment_id = a.id;
  return 'concluded';
end;
$$;


-- 7. EXECUÇÃO AGENDADA ----------------------------------------------------------------
-- p_now / p_process_from / p_batch / p_force existem SÓ para testes (a função é
-- privada). O cron chama run_auto_conclusion(), que usa os valores reais.
create or replace function aurea_private._run(
  p_now timestamptz,
  p_process_from timestamptz default null,
  p_batch int default null,
  p_force boolean default false)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  s aurea_private.settings%rowtype;
  v_from timestamptz;
  v_cutoff timestamptz;
  v_run uuid;
  r record;
  v_out text;
  v_state text;
  v_msg text;
  v_selected int := 0;
  v_concluded int := 0;
  v_skipped int := 0;
  v_failed int := 0;
  v_total numeric := 0;
  v_status text;
begin
  select * into s from aurea_private.settings where id;
  v_from := coalesce(p_process_from, s.process_from);
  if v_from is null or (not p_force and not s.enabled) then
    return jsonb_build_object('status', 'disabled');
  end if;
  if not pg_try_advisory_xact_lock(20261015) then
    return jsonb_build_object('status', 'busy');
  end if;
  perform set_config('statement_timeout', '240s', true);
  v_cutoff := p_now - s.grace;

  -- anomalias dentro da janela: registradas UMA vez, nunca concluídas
  insert into aurea_private.appointment_state (appointment_id, company_id, status, reason, last_attempt_at)
  select a.id, a.company_id, 'anomaly', x.reason, p_now
  from appointments a
  cross join lateral (select aurea_private.appointment_ineligibility(a.id, v_cutoff, v_from) as reason) x
  where a.status in ('agendado', 'confirmado', 'em_atendimento')
    and a.scheduled_end >= v_from and a.scheduled_end <= v_cutoff
    and x.reason in ('price', 'has_payment', 'history_cancel_or_no_show')
  on conflict (appointment_id) do nothing;

  for r in
    select a.id, a.company_id, a.price
    from appointments a
    where a.status in ('agendado', 'confirmado', 'em_atendimento')
      and a.scheduled_end >= v_from and a.scheduled_end <= v_cutoff
      and aurea_private.appointment_ineligibility(a.id, v_cutoff, v_from) is null
      and not exists (select 1 from aurea_private.appointment_state st
                       where st.appointment_id = a.id and st.status = 'retry'
                         and st.last_attempt_at > p_now - s.retry_interval)
    order by a.scheduled_end, a.id
    limit coalesce(p_batch, s.batch_limit)
  loop
    if v_run is null then
      insert into aurea_private.runs (kind, now_ref, cutoff, process_from)
      values ('scheduled', p_now, v_cutoff, v_from)
      returning id into v_run;
    end if;
    v_selected := v_selected + 1;
    begin
      v_out := aurea_private._conclude_one(r.id, v_run, 'auto', v_cutoff, v_from, false);
      if v_out = 'concluded' then
        v_concluded := v_concluded + 1;
        v_total := v_total + r.price;
      else
        v_skipped := v_skipped + 1;
        insert into aurea_private.run_items (run_id, appointment_id, company_id, outcome, reason)
        values (v_run, r.id, r.company_id, 'skipped', v_out);
      end if;
    exception when others then
      -- só este atendimento foi desfeito; o registro da falha fica na transação da execução
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_failed := v_failed + 1;
      insert into aurea_private.run_items (run_id, appointment_id, company_id, outcome, reason, sqlstate, message)
      values (v_run, r.id, r.company_id, 'failed', 'error', v_state, v_msg);
      insert into aurea_private.appointment_state as st
        (appointment_id, company_id, status, reason, attempts, last_attempt_at, last_sqlstate, last_message)
      values (r.id, r.company_id, case when s.max_attempts <= 1 then 'blocked' else 'retry' end,
              'error', 1, p_now, v_state, v_msg)
      on conflict (appointment_id) do update
        set attempts = st.attempts + 1,
            status = case when st.attempts + 1 >= s.max_attempts then 'blocked' else 'retry' end,
            reason = 'error',
            last_attempt_at = p_now,
            last_sqlstate = excluded.last_sqlstate,
            last_message = excluded.last_message,
            updated_at = now();
    end;
  end loop;
  set constraints all deferred;

  v_status := case when v_run is null then 'idle' when v_failed > 0 then 'partial' else 'ok' end;
  if v_run is not null then
    update aurea_private.runs
    set status = v_status, selected = v_selected, concluded = v_concluded, skipped = v_skipped,
        failed = v_failed, total_amount = v_total, finished_at = clock_timestamp()
    where id = v_run;
  end if;
  update aurea_private.settings
  set last_run_at = now(), last_run_status = v_status, last_run_id = coalesce(v_run, last_run_id)
  where id;

  return jsonb_build_object('status', v_status, 'run_id', v_run, 'selected', v_selected,
                            'concluded', v_concluded, 'skipped', v_skipped, 'failed', v_failed,
                            'total', v_total, 'cutoff', v_cutoff, 'process_from', v_from);
end;
$$;

-- ponto de entrada do cron (0016): sem parâmetros, valores reais
create or replace function aurea_private.run_auto_conclusion()
returns jsonb
language sql
set search_path = public, pg_temp
as $$
  select aurea_private._run(now());
$$;


-- 8. REGULARIZAÇÃO (tudo ou nada) ----------------------------------------------------
-- Corte: 00:00 de hoje em São Paulo. Candidatos: em aberto, término ANTES do
-- corte e elegíveis pela mesma regra da automação. Dry run grava só o próprio
-- registro. Execução exige o conjunto EXATO de IDs e o total esperado; qualquer
-- divergência ou falha desfaz tudo e deixa só o registro da tentativa (aborted).
-- Não é permitida depois da ativação.
create or replace function aurea_private.regularize(
  p_expected_ids uuid[] default null,
  p_expected_total numeric default null,
  p_dry_run boolean default true,
  p_now timestamptz default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_cutoff timestamptz := aurea_private.sp_day_start(coalesce(p_now, now()));
  v_run uuid;
  v_ids uuid[];
  v_total numeric;
  v_expected uuid[];
  v_anomalies jsonb;
  v_id uuid;
  v_out text;
  v_check_n int;
  v_check_total numeric;
  v_state text;
  v_msg text;
begin
  insert into aurea_private.runs (kind, now_ref, cutoff, expected_ids, expected_total)
  values (case when p_dry_run then 'regularization_dry_run' else 'regularization' end,
          v_now, v_cutoff, p_expected_ids, p_expected_total)
  returning id into v_run;

  begin
    if (select process_from from aurea_private.settings where id) is not null then
      raise exception 'A conclusão automática já foi ativada; a regularização não é mais permitida.'
        using errcode = 'AUR10';
    end if;
    if not pg_try_advisory_xact_lock(20261015) then
      raise exception 'Outra execução está em andamento. Tente de novo.' using errcode = 'AUR11';
    end if;

    select coalesce(array_agg(a.id order by a.id), '{}'::uuid[]), coalesce(sum(a.price), 0)
    into v_ids, v_total
    from appointments a
    where a.status in ('agendado', 'confirmado', 'em_atendimento')
      and a.scheduled_end < v_cutoff
      and aurea_private.appointment_ineligibility(a.id, v_cutoff, null) is null;

    select coalesce(jsonb_agg(jsonb_build_object('appointment_id', a.id, 'motivo', x.reason) order by a.id), '[]'::jsonb)
    into v_anomalies
    from appointments a
    cross join lateral (select aurea_private.appointment_ineligibility(a.id, v_cutoff, null) as reason) x
    where a.status in ('agendado', 'confirmado', 'em_atendimento')
      and a.scheduled_end < v_cutoff
      and x.reason is not null;

    if p_dry_run then
      insert into aurea_private.run_items (run_id, appointment_id, company_id, client_id, outcome, amount)
      select v_run, a.id, a.company_id, a.client_id, 'would_conclude', a.price
      from appointments a where a.id = any (v_ids);
      update aurea_private.runs
      set status = 'ok', selected = cardinality(v_ids), total_amount = v_total, finished_at = clock_timestamp(),
          message = 'dry run: nenhum atendimento, recebimento ou cliente foi alterado'
      where id = v_run;
      return jsonb_build_object(
        'status', 'dry_run', 'run_id', v_run, 'cutoff', v_cutoff,
        'candidatos', (select coalesce(jsonb_agg(jsonb_build_object(
                          'appointment_id', a.id, 'empresa', co.name, 'valor', a.price,
                          'fim_sp', to_char(a.scheduled_end at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI'))
                          order by a.id), '[]'::jsonb)
                       from appointments a join companies co on co.id = a.company_id where a.id = any (v_ids)),
        'quantidade', cardinality(v_ids), 'total', v_total,
        'anomalias_nao_tocadas', v_anomalies);
    end if;

    if p_expected_ids is null or p_expected_total is null then
      raise exception 'Informe os IDs e o total esperados (confira antes com o dry run).' using errcode = 'AUR12';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_expected from unnest(p_expected_ids) x;
    if cardinality(v_expected) <> cardinality(p_expected_ids) then
      raise exception 'A lista de IDs esperados tem repetições.' using errcode = 'AUR12';
    end if;
    if v_expected is distinct from v_ids then
      raise exception 'Os atendimentos encontrados % não são exatamente os esperados %.', v_ids, v_expected
        using errcode = 'AUR13';
    end if;
    if round(p_expected_total, 2) <> round(v_total, 2) then
      raise exception 'O total encontrado (%) é diferente do esperado (%).', v_total, p_expected_total
        using errcode = 'AUR14';
    end if;

    foreach v_id in array v_ids loop
      v_out := aurea_private._conclude_one(v_id, v_run, 'backfill', v_cutoff, null, false);
      if v_out <> 'concluded' then
        raise exception 'O atendimento % não pôde ser concluído (%).', v_id, v_out using errcode = 'AUR15';
      end if;
    end loop;
    set constraints all deferred;

    select count(*), coalesce(sum(amount), 0) into v_check_n, v_check_total
    from aurea_private.run_items where run_id = v_run and outcome = 'concluded';
    if v_check_n <> cardinality(v_ids) or round(v_check_total, 2) <> round(p_expected_total, 2) then
      raise exception 'Conferência final divergente (% itens, total %).', v_check_n, v_check_total
        using errcode = 'AUR16';
    end if;

    update aurea_private.runs
    set status = 'ok', selected = v_check_n, concluded = v_check_n, total_amount = v_check_total,
        finished_at = clock_timestamp()
    where id = v_run;
    return jsonb_build_object('status', 'ok', 'run_id', v_run, 'cutoff', v_cutoff,
                              'concluidos', v_check_n, 'total', v_check_total,
                              'anomalias_nao_tocadas', v_anomalies);
  exception when others then
    -- tudo o que foi feito dentro do bloco foi desfeito; só o registro da tentativa fica
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    update aurea_private.runs
    set status = 'aborted', message = v_state || ': ' || v_msg, finished_at = clock_timestamp()
    where id = v_run;
    return jsonb_build_object('status', 'aborted', 'run_id', v_run, 'sqlstate', v_state, 'mensagem', v_msg);
  end;
end;
$$;


-- 9. ATIVAÇÃO (uma única vez) -----------------------------------------------------
-- Exige uma regularização EFETIVADA (não dry run), com status ok, cujo corte é
-- o 00:00 de HOJE em São Paulo, e nenhum atendimento elegível restante antes do
-- corte. Grava process_from = esse corte e liga a chave. Qualquer falha
-- aborta a transação inteira: nada de configuração parcial.
create or replace function aurea_private.activate_auto_conclusion(
  p_regularization_run_id uuid,
  p_now timestamptz default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz := aurea_private.sp_day_start(coalesce(p_now, now()));
  s aurea_private.settings%rowtype;
  r aurea_private.runs%rowtype;
  v_left int;
begin
  select * into s from aurea_private.settings where id for update;
  if s.process_from is not null then
    raise exception 'A conclusão automática já foi ativada (início em %).', s.process_from using errcode = 'AUR20';
  end if;
  select * into r from aurea_private.runs where id = p_regularization_run_id;
  if not found or r.kind <> 'regularization' or r.status <> 'ok' then
    raise exception 'A execução informada não é uma regularização efetivada com sucesso.' using errcode = 'AUR21';
  end if;
  if r.cutoff is distinct from v_cutoff then
    raise exception 'A regularização informada é de outro dia (corte %); o corte de hoje em São Paulo é %. Refaça o dry run e a regularização hoje.',
      r.cutoff, v_cutoff using errcode = 'AUR22';
  end if;
  select count(*) into v_left
  from appointments a
  where a.status in ('agendado', 'confirmado', 'em_atendimento')
    and a.scheduled_end < v_cutoff
    and aurea_private.appointment_ineligibility(a.id, v_cutoff, null) is null;
  if v_left > 0 then
    raise exception 'Ainda há % atendimento(s) em aberto antes do corte. Refaça a regularização.', v_left
      using errcode = 'AUR23';
  end if;

  perform set_config('aurea_private.activating', 'on', true);
  update aurea_private.settings
  set process_from = v_cutoff, activation_run_id = r.id, activated_at = now(),
      activated_by = current_user, enabled = true
  where id;
  perform set_config('aurea_private.activating', 'off', true);

  return jsonb_build_object('status', 'ativada', 'process_from', v_cutoff,
                            'process_from_sp', to_char(v_cutoff at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI'),
                            'regularizacao', r.id);
end;
$$;

-- chave geral (liga/desliga sem mexer no cron). Ligar exige a ativação feita.
create or replace function aurea_private.set_auto_conclusion_enabled(p_enabled boolean)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update aurea_private.settings set enabled = p_enabled where id;
  return (select jsonb_build_object('enabled', enabled, 'process_from', process_from)
          from aurea_private.settings where id);
end;
$$;


-- 10. REVERSÃO ESTRITA DE UMA EXECUÇÃO ----------------------------------------------
-- Trava atendimento, recebimento e cliente e só reverte se NADA mudou depois
-- (7 sinais). Contagens de auditoria/histórico (tabelas só-acréscimo para a
-- API) detectam até correções concorrentes cujo horário é anterior. Tudo ou
-- nada por execução. O atendimento revertido sai da automação para sempre.
create or replace function aurea_private.revert_run(p_run_id uuid, p_dry_run boolean default true)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rev uuid;
  r aurea_private.runs%rowtype;
  it record;
  cl record;
  a appointments%rowtype;
  p payments%rowtype;
  c clients%rowtype;
  v_sig text[];
  v_blocked jsonb := '[]'::jsonb;
  v_n int := 0;
  v_state text;
  v_msg text;
  v_detail text;
begin
  insert into aurea_private.runs (kind, now_ref, target_run_id)
  values (case when p_dry_run then 'revert_dry_run' else 'revert' end, now(), p_run_id)
  returning id into v_rev;

  begin
    if not pg_try_advisory_xact_lock(20261015) then
      raise exception 'Outra execução está em andamento. Tente de novo.' using errcode = 'AUR30';
    end if;
    select * into r from aurea_private.runs where id = p_run_id;
    if not found or r.kind not in ('scheduled', 'regularization') then
      raise exception 'A execução informada não é uma conclusão automática nem uma regularização.' using errcode = 'AUR31';
    end if;
    if not exists (select 1 from aurea_private.run_items
                    where run_id = p_run_id and outcome = 'concluded' and reverted_run_id is null) then
      raise exception 'Nada a reverter nesta execução.' using errcode = 'AUR32';
    end if;

    -- (a) verificação de TODOS os itens antes de qualquer alteração
    for it in select * from aurea_private.run_items
               where run_id = p_run_id and outcome = 'concluded' and reverted_run_id is null
               order by seq
    loop
      v_sig := '{}';
      select * into a from appointments where id = it.appointment_id for update;
      if a.id is null then
        v_sig := array_append(v_sig, 'atendimento_removido');
      else
        if to_jsonb(a) is distinct from it.after_appt then v_sig := array_append(v_sig, 'atendimento_alterado'); end if;
        if (select count(*) from audit_logs l where l.entity = 'appointments' and l.entity_id = a.id) <> it.n_audit_appt then
          v_sig := array_append(v_sig, 'auditoria_atendimento');
        end if;
        if (select count(*) from appointment_status_history h where h.appointment_id = a.id) <> it.n_history then
          v_sig := array_append(v_sig, 'historico_status');
        end if;
      end if;
      select * into p from payments where appointment_id = it.appointment_id for update;
      if p.id is null or p.id <> it.payment_id then
        v_sig := array_append(v_sig, 'pagamento_removido_ou_trocado');
      else
        if p.modified_at is not null then v_sig := array_append(v_sig, 'pagamento_modificado'); end if;
        if to_jsonb(p) is distinct from it.after_payment then v_sig := array_append(v_sig, 'pagamento_campos'); end if;
      end if;
      if (select count(*) from audit_logs l where l.entity = 'payments' and l.entity_id = it.payment_id) <> it.n_audit_payment then
        v_sig := array_append(v_sig, 'auditoria_pagamento');
      end if;
      if cardinality(v_sig) > 0 then
        v_blocked := v_blocked || jsonb_build_array(jsonb_build_object('appointment_id', it.appointment_id, 'sinais', v_sig));
      end if;
    end loop;

    -- visitas da cliente: comparadas com a foto do ÚLTIMO item da cliente nesta execução
    for cl in select distinct on (client_id) client_id, after_first_visit, after_last_visit, appointment_id
              from aurea_private.run_items
              where run_id = p_run_id and outcome = 'concluded' and reverted_run_id is null
              order by client_id, seq desc
    loop
      select * into c from clients where id = cl.client_id for update;
      if c.id is null or c.first_visit_at is distinct from cl.after_first_visit
         or c.last_visit_at is distinct from cl.after_last_visit then
        v_blocked := v_blocked || jsonb_build_array(jsonb_build_object('client_id', cl.client_id, 'sinais', array['visitas_cliente']));
      end if;
    end loop;

    if jsonb_array_length(v_blocked) > 0 then
      raise exception 'Reversão bloqueada: houve alterações depois da conclusão automática.'
        using errcode = 'AUR33', detail = v_blocked::text;
    end if;

    if p_dry_run then
      select count(*) into v_n from aurea_private.run_items
      where run_id = p_run_id and outcome = 'concluded' and reverted_run_id is null;
      update aurea_private.runs set status = 'ok', selected = v_n, finished_at = clock_timestamp(),
             message = 'dry run: reversível, nada foi alterado' where id = v_rev;
      return jsonb_build_object('status', 'dry_run', 'run_id', v_rev, 'reversivel', true, 'itens', v_n);
    end if;

    -- (b) reversão
    for it in select * from aurea_private.run_items
               where run_id = p_run_id and outcome = 'concluded' and reverted_run_id is null
               order by seq
    loop
      set constraints all deferred;
      delete from payments where id = it.payment_id;
      update appointments
      set status = it.before_status, payment_method = it.before_payment_method, completed_at = it.before_completed_at
      where id = it.appointment_id;
      update appointment_status_history
      set note = format('Revertido: conclusão automática desfeita (execução %s, reversão %s).', p_run_id, v_rev)
      where id = (select h.id from appointment_status_history h
                   where h.appointment_id = it.appointment_id and h.status = it.before_status
                   order by h.changed_at desc limit 1);
      set constraints all immediate;
      update aurea_private.run_items set reverted_run_id = v_rev where seq = it.seq;
      insert into aurea_private.appointment_state as st (appointment_id, company_id, status, reason, last_attempt_at)
      values (it.appointment_id, it.company_id, 'excluded', 'reverted', now())
      on conflict (appointment_id) do update set status = 'excluded', reason = 'reverted', updated_at = now();
      v_n := v_n + 1;
    end loop;
    -- visitas: restaura o estado de ANTES do PRIMEIRO item de cada cliente
    for cl in select distinct on (client_id) client_id, before_first_visit, before_last_visit
              from aurea_private.run_items
              where run_id = p_run_id and outcome = 'concluded' and reverted_run_id = v_rev
              order by client_id, seq asc
    loop
      update clients set first_visit_at = cl.before_first_visit, last_visit_at = cl.before_last_visit
      where id = cl.client_id;
    end loop;
    set constraints all deferred;

    update aurea_private.runs set status = 'ok', concluded = v_n, finished_at = clock_timestamp() where id = v_rev;
    return jsonb_build_object('status', 'ok', 'run_id', v_rev, 'revertidos', v_n);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
    update aurea_private.runs
    set status = 'aborted', message = v_state || ': ' || v_msg, finished_at = clock_timestamp()
    where id = v_rev;
    return jsonb_build_object('status', case when v_state = 'AUR33' then 'bloqueada' else 'aborted' end,
                              'run_id', v_rev, 'sqlstate', v_state, 'mensagem', v_msg,
                              'bloqueios', case when v_state = 'AUR33' then v_detail::jsonb end);
  end;
end;
$$;


-- 11. PRIVILÉGIOS: nada da 0015 é utilizável pela API --------------------------------
-- Todas as funções acima são SECURITY INVOKER (padrão): rodam com o papel de
-- quem chama. Só o dono (quem aplicou a migration; no Supabase, postgres) e o
-- cron (agendado pelo postgres na 0016) as executam. search_path fixado.
revoke all on all functions in schema aurea_private from public;
revoke all on all tables in schema aurea_private from public;
revoke all on all sequences in schema aurea_private from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all functions in schema aurea_private from %I', r);
      execute format('revoke all on all tables in schema aurea_private from %I', r);
      execute format('revoke all on all sequences in schema aurea_private from %I', r);
      execute format('revoke all on schema aurea_private from %I', r);
    end if;
  end loop;
end $$;
