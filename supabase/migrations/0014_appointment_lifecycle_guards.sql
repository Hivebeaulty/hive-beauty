-- ---------------------------------------------------------------------------
-- 0014 — Ciclo de vida do atendimento: proteções, pendência e reclassificação
--
-- Prepara o terreno para a conclusão automática (0015) sem depender dela.
--
--   1. payments.source / modified_at / modified_by
--        origem do recebimento ('manual' | 'auto' | 'backfill') e marca de
--        "alterado depois de criado", gravadas SÓ pelo banco.
--   2. Atendimento concluído é imutável pela API (anon/authenticated):
--        não muda status, valores, datas, cliente, serviço nem profissional
--        (só a observação) e não pode ser apagado diretamente. Também não se
--        conclui por UPDATE/INSERT direto: só pelas funções do banco.
--   3. Invariante atendimento x recebimento, verificada no COMMIT (qualquer papel):
--        concluído  => tem recebimento; não concluído => não tem recebimento;
--        recebimento = mesma empresa e mesma cliente do atendimento.
--        Só é checado nas linhas TOCADAS na transação: registros antigos que
--        já estejam fora da regra não são alterados nem bloqueiam nada.
--   4. mark_appointment_payment_pending          recebido -> pendente
--      (pendente -> recebido continua em update_appointment_payment, 0012)
--   5. reclassify_appointment_as_no_show         concluído AUTOMATICAMENTE ->
--        não compareceu, removendo o recebimento automático SOMENTE se ele não
--        foi alterado depois de criado.
--      get_appointment_no_show_eligibility       a tela sabe se pode oferecer.
--
-- Não altera dados existentes (as colunas novas não disparam gatilhos ao serem
-- criadas; recebimentos atuais ficam como source = 'manual'), não altera RLS,
-- policies, migrations anteriores nem as funções de 0010/0012.
-- Requer 0012 aplicada.
-- ---------------------------------------------------------------------------

-- 0. PREFLIGHT -----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'update_appointment_payment')
     or not exists (select 1 from pg_indexes where indexname = 'payments_appointment_id_unique') then
    raise exception '0014 ABORTADA — nada foi alterado. Aplique antes as migrations 0010 a 0013.'
      using errcode = '55000';
  end if;
end $$;


-- 1. ORIGEM DO RECEBIMENTO E MARCA DE ALTERAÇÃO ---------------------------------
-- ADD COLUMN com DEFAULT constante não reescreve linhas nem dispara gatilhos
-- (auditoria intacta). Todo recebimento existente passa a ser lido como 'manual'.
alter table payments
  add column if not exists source text not null default 'manual'
    constraint payments_source_check check (source in ('manual', 'auto', 'backfill')),
  add column if not exists modified_at timestamptz,
  add column if not exists modified_by uuid references auth.users (id) on delete set null;

-- Regras (nenhum papel consegue forjar):
--   * INSERT pela API (anon/authenticated): source é sempre 'manual'. As origens
--     'auto'/'backfill' só podem ser gravadas por funções do banco (0015).
--   * source nunca muda depois de criado.
--   * modified_at/by: preenchidos pelo banco quando qualquer campo de negócio
--     muda; nunca podem ser apagados ou escritos à mão.
-- Roda DEPOIS de trg_normalize_payment_amount (ordem alfabética dos BEFORE),
-- então compara os valores já normalizados.
create or replace function payments_track_origin()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('anon', 'authenticated') then
      new.source := 'manual';
    end if;
    new.modified_at := null;
    new.modified_by := null;
    return new;
  end if;

  new.source := old.source;

  if (new.company_id, new.appointment_id, new.client_id, new.amount, new.paid_amount,
      new.method, new.status, new.paid_at, new.description)
     is distinct from
     (old.company_id, old.appointment_id, old.client_id, old.amount, old.paid_amount,
      old.method, old.status, old.paid_at, old.description) then
    new.modified_at := now();
    new.modified_by := auth.uid();
  else
    new.modified_at := old.modified_at;
    new.modified_by := old.modified_by;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payments_track_origin on payments;
create trigger trg_payments_track_origin
  before insert or update on payments
  for each row execute function payments_track_origin();


-- 2. ATENDIMENTO CONCLUÍDO É IMUTÁVEL PELA API ------------------------------------
-- Por que current_user: dentro de uma função SECURITY DEFINER (conclude_appointment,
-- delete_appointment, as funções abaixo e a futura automação) o gatilho enxerga o
-- DONO da função, não 'authenticated'. Uma chamada direta da API (PostgREST) roda
-- como 'authenticated'/'anon'. O usuário não consegue trocar de papel pela API.
-- Por isso esta função NÃO é SECURITY DEFINER (senão veria sempre o dono).
create or replace function appointments_guard_lifecycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'concluido' then
      raise exception 'Um atendimento só pode ser concluído pelo registro do atendimento.'
        using errcode = '22023';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'concluido' then
      raise exception 'Atendimento concluído não pode ser apagado diretamente. Use "Excluir atendimento".'
        using errcode = '22023';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.status = 'concluido' then
    if (new.status, new.company_id, new.client_id, new.service_id, new.professional_member_id,
        new.scheduled_start, new.scheduled_end, new.price, new.payment_method, new.completed_at)
       is distinct from
       (old.status, old.company_id, old.client_id, old.service_id, old.professional_member_id,
        old.scheduled_start, old.scheduled_end, old.price, old.payment_method, old.completed_at) then
      raise exception 'Este atendimento já foi concluído e não pode ser alterado por aqui.'
        using errcode = '22023';
    end if;
  elsif new.status = 'concluido' then
    raise exception 'Um atendimento só pode ser concluído pelo registro do atendimento.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_appointments_guard_lifecycle on appointments;
create trigger trg_appointments_guard_lifecycle
  before insert or update or delete on appointments
  for each row execute function appointments_guard_lifecycle();


-- 3. INVARIANTE ATENDIMENTO x RECEBIMENTO (no COMMIT, qualquer papel) --------------
-- SECURITY DEFINER: payments é admin-only por RLS; sem isso a checagem "não
-- enxergaria" o recebimento quando quem age é uma profissional.
create or replace function assert_appointment_payment_consistency(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status appointment_status;
  v_company_id uuid;
  v_client_id uuid;
  v_payments int;
  v_mismatch int;
begin
  if p_appointment_id is null then
    return;
  end if;

  select status, company_id, client_id into v_status, v_company_id, v_client_id
  from appointments where id = p_appointment_id;
  if not found then
    return; -- atendimento excluído na mesma transação (delete_appointment)
  end if;

  select count(*),
         count(*) filter (where company_id <> v_company_id or client_id is distinct from v_client_id)
  into v_payments, v_mismatch
  from payments where appointment_id = p_appointment_id;

  if v_status = 'concluido' and v_payments = 0 then
    raise exception 'Atendimento concluído precisa ter o recebimento registrado. Para remover o recebimento, use "Excluir atendimento".'
      using errcode = '23514';
  end if;
  if v_status <> 'concluido' and v_payments > 0 then
    raise exception 'Só atendimento concluído pode ter recebimento.'
      using errcode = '23514';
  end if;
  if v_mismatch > 0 then
    raise exception 'O recebimento precisa ser da mesma empresa e da mesma cliente do atendimento.'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function check_appointment_payment_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'appointments' then
    perform assert_appointment_payment_consistency(new.id);
  else
    if tg_op in ('UPDATE', 'DELETE') then
      perform assert_appointment_payment_consistency(old.appointment_id);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform assert_appointment_payment_consistency(new.appointment_id);
    end if;
  end if;
  return null;
end;
$$;

revoke all on function assert_appointment_payment_consistency(uuid) from public, anon, authenticated;
revoke all on function check_appointment_payment_consistency() from public, anon, authenticated;

drop trigger if exists trg_appointments_payment_consistency_ins on appointments;
create constraint trigger trg_appointments_payment_consistency_ins
  after insert on appointments
  deferrable initially deferred
  for each row when (new.status = 'concluido')
  execute function check_appointment_payment_consistency();

drop trigger if exists trg_appointments_payment_consistency_upd on appointments;
create constraint trigger trg_appointments_payment_consistency_upd
  after update of status on appointments
  deferrable initially deferred
  for each row when (old.status is distinct from new.status)
  execute function check_appointment_payment_consistency();

drop trigger if exists trg_payments_appointment_consistency on payments;
create constraint trigger trg_payments_appointment_consistency
  after insert or delete or update of appointment_id, client_id, company_id on payments
  deferrable initially deferred
  for each row
  execute function check_appointment_payment_consistency();


-- 4. RECEBIDO -> PENDENTE ---------------------------------------------------------
-- Mesmo critério de papel de update_appointment_payment (0012): owner/admin
-- qualquer atendimento da empresa; profissional só o seu; recepção nenhum.
-- Atualiza o recebimento EXISTENTE (nunca cria outro). Repetir é inofensivo.
-- Pagamento 'parcial' é recusado: virar pendente apagaria o valor já recebido.
create or replace function mark_appointment_payment_pending(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_professional_member_id uuid;
  v_status appointment_status;
  v_caller_member_id uuid;
  v_caller_role member_role;
  v_payment_id uuid;
  v_payment_status payment_status;
  v_amount numeric;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado.' using errcode = '28000';
  end if;

  select company_id, professional_member_id
  into v_company_id, v_professional_member_id
  from appointments
  where id = p_appointment_id;

  if v_company_id is null or not is_company_member(v_company_id) then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;

  select id, role into v_caller_member_id, v_caller_role
  from company_members
  where company_id = v_company_id and user_id = auth.uid() and active = true
  limit 1;

  if v_caller_role is null or v_caller_role not in ('owner', 'admin', 'professional') then
    raise exception 'Seu papel não permite alterar este recebimento.' using errcode = '42501';
  end if;
  if v_caller_role = 'professional' and v_professional_member_id is distinct from v_caller_member_id then
    raise exception 'Você só pode alterar atendimentos atribuídos a você.' using errcode = '42501';
  end if;

  select status into v_status from appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  if v_status <> 'concluido' then
    raise exception 'Só é possível alterar o recebimento de um atendimento concluído.' using errcode = '22023';
  end if;

  select id, status, amount into v_payment_id, v_payment_status, v_amount
  from payments
  where appointment_id = p_appointment_id
  for update;
  if v_payment_id is null then
    raise exception 'Este atendimento não tem recebimento registrado.' using errcode = 'P0002';
  end if;

  if v_payment_status = 'pendente' then
    return jsonb_build_object('changed', false, 'status', 'pendente', 'amount', v_amount);
  end if;
  if v_payment_status = 'parcial' then
    raise exception 'Este recebimento é parcial. Ajuste-o pelo Financeiro.' using errcode = 'AUR03';
  end if;

  -- status, paid_amount e paid_at no MESMO UPDATE (CHECK payments_status_consistency)
  update payments
  set status = 'pendente',
      paid_amount = 0,
      paid_at = null
  where id = v_payment_id;

  return jsonb_build_object('changed', true, 'status', 'pendente', 'amount', v_amount);
end;
$$;

revoke all on function mark_appointment_payment_pending(uuid) from public, anon;
grant execute on function mark_appointment_payment_pending(uuid) to authenticated;


-- 5. RECLASSIFICAR CONCLUSÃO AUTOMÁTICA COMO FALTA ---------------------------------
-- Só para recebimento criado pelo banco ('auto' ou 'backfill') e NUNCA alterado
-- depois (modified_at nulo). Uma transação: remove o recebimento automático,
-- marca o atendimento como 'nao_compareceu', anota o histórico de status e
-- recalcula primeira/última visita da cliente (mesma regra de delete_appointment).
-- Rastreabilidade: audit_logs guarda o recebimento removido ("before") e quem
-- fez; appointment_status_history guarda a nota da reclassificação.
create or replace function get_appointment_no_show_eligibility(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_professional_member_id uuid;
  v_status appointment_status;
  v_caller_member_id uuid;
  v_caller_role member_role;
  v_source text;
  v_modified_at timestamptz;
  v_found boolean;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado.' using errcode = '28000';
  end if;

  select company_id, professional_member_id, status
  into v_company_id, v_professional_member_id, v_status
  from appointments
  where id = p_appointment_id;

  if v_company_id is null or not is_company_member(v_company_id) then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;

  select id, role into v_caller_member_id, v_caller_role
  from company_members
  where company_id = v_company_id and user_id = auth.uid() and active = true
  limit 1;

  if v_caller_role is null or v_caller_role not in ('owner', 'admin', 'professional') then
    raise exception 'Seu papel não permite esta operação.' using errcode = '42501';
  end if;
  if v_caller_role = 'professional' and v_professional_member_id is distinct from v_caller_member_id then
    raise exception 'Você só pode alterar atendimentos atribuídos a você.' using errcode = '42501';
  end if;

  if v_status <> 'concluido' then
    return jsonb_build_object('eligible', false, 'reason', 'not_concluded');
  end if;

  select true, source, modified_at into v_found, v_source, v_modified_at
  from payments where appointment_id = p_appointment_id;

  if v_found is null then
    return jsonb_build_object('eligible', false, 'reason', 'no_payment');
  end if;
  if v_source not in ('auto', 'backfill') then
    return jsonb_build_object('eligible', false, 'reason', 'manual');
  end if;
  if v_modified_at is not null then
    return jsonb_build_object('eligible', false, 'reason', 'modified');
  end if;
  return jsonb_build_object('eligible', true, 'reason', 'ok');
end;
$$;

revoke all on function get_appointment_no_show_eligibility(uuid) from public, anon;
grant execute on function get_appointment_no_show_eligibility(uuid) to authenticated;

create or replace function reclassify_appointment_as_no_show(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_client_id uuid;
  v_professional_member_id uuid;
  v_status appointment_status;
  v_caller_member_id uuid;
  v_caller_role member_role;
  v_payment payments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado.' using errcode = '28000';
  end if;

  select company_id, professional_member_id
  into v_company_id, v_professional_member_id
  from appointments
  where id = p_appointment_id;

  if v_company_id is null or not is_company_member(v_company_id) then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;

  select id, role into v_caller_member_id, v_caller_role
  from company_members
  where company_id = v_company_id and user_id = auth.uid() and active = true
  limit 1;

  if v_caller_role is null or v_caller_role not in ('owner', 'admin', 'professional') then
    raise exception 'Seu papel não permite esta operação.' using errcode = '42501';
  end if;
  if v_caller_role = 'professional' and v_professional_member_id is distinct from v_caller_member_id then
    raise exception 'Você só pode alterar atendimentos atribuídos a você.' using errcode = '42501';
  end if;

  -- só depois de provar empresa e papel é que as linhas são travadas
  select client_id, status into v_client_id, v_status
  from appointments where id = p_appointment_id
  for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  if v_status <> 'concluido' then
    raise exception 'Só um atendimento concluído pode ser reclassificado como falta.' using errcode = '22023';
  end if;

  select * into v_payment from payments where appointment_id = p_appointment_id for update;
  if v_payment.id is null or v_payment.source not in ('auto', 'backfill') then
    raise exception 'Este atendimento foi registrado manualmente; a reclassificação automática não se aplica.'
      using errcode = 'AUR01';
  end if;
  if v_payment.modified_at is not null then
    raise exception 'O recebimento foi alterado depois da conclusão automática; ajuste manualmente.'
      using errcode = 'AUR02';
  end if;

  -- 1) remove o recebimento automático (audit_logs guarda o registro completo)
  delete from payments where id = v_payment.id;

  -- 2) atendimento -> não compareceu (o histórico de status é gravado pelo gatilho)
  update appointments
  set status = 'nao_compareceu',
      completed_at = null,
      payment_method = null
  where id = p_appointment_id;

  -- 3) nota na entrada de histórico recém-criada pelo gatilho
  update appointment_status_history
  set note = format(
        'Reclassificado de concluído (%s) para não compareceu. Recebimento removido: %s %s (%s).',
        case v_payment.source when 'auto' then 'automático' else 'regularização' end,
        to_char(v_payment.amount, 'FM999999990.00'),
        v_payment.method,
        v_payment.status)
  where id = (
    select h.id from appointment_status_history h
    where h.appointment_id = p_appointment_id and h.status = 'nao_compareceu'
    order by h.changed_at desc
    limit 1
  );

  -- 4) primeira/última visita derivadas dos concluídos (mesma regra de delete_appointment)
  update clients c
  set last_visit_at = s.last_day,
      first_visit_at = s.first_day
  from (
    select max((coalesce(a.completed_at, a.scheduled_start) at time zone 'America/Sao_Paulo')::date) as last_day,
           min((coalesce(a.completed_at, a.scheduled_start) at time zone 'America/Sao_Paulo')::date) as first_day
    from appointments a
    where a.client_id = v_client_id and a.status = 'concluido'
  ) s
  where c.id = v_client_id;

  return jsonb_build_object(
    'status', 'nao_compareceu',
    'payment_removed', true,
    'payment_amount', v_payment.amount,
    'payment_method', v_payment.method,
    'payment_source', v_payment.source
  );
end;
$$;

revoke all on function reclassify_appointment_as_no_show(uuid) from public, anon;
grant execute on function reclassify_appointment_as_no_show(uuid) to authenticated;

notify pgrst, 'reload schema';
