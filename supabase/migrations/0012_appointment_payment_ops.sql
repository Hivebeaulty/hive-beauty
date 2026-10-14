-- ---------------------------------------------------------------------------
-- 0012 — Operações sobre o pagamento de um atendimento concluído
--
--   1. get_appointment_payment      ler o recebimento do atendimento
--   2. update_appointment_payment   alterar a forma de pagamento / marcar recebido
--   3. delete_appointment           excluir atendimento concluído + recebimento
--   4. gatilho em appointments      nunca deixar pagamento órfão
--
-- Por que RPC: payments é restrito a owner/admin por RLS (0004). A profissional
-- que concluiu o atendimento não enxerga a tabela, mas precisa ver/corrigir a
-- forma de pagamento do SEU atendimento. As funções são SECURITY DEFINER,
-- derivam a empresa da PRÓPRIA linha do atendimento (nenhum company_id vem do
-- frontend) e repetem as regras de papel de conclude_appointment.
--
-- Requer a 0011 já aplicada (valores 'cartao_credito'/'cartao_debito').
-- Não altera dados, RLS, constraints nem migrations anteriores.
-- ---------------------------------------------------------------------------

-- 1. Ler o recebimento de um atendimento ---------------------------------------
-- owner/admin: qualquer atendimento da empresa. professional: só o seu.
-- reception: nenhum (mesmo critério de conclude_appointment).
create or replace function get_appointment_payment(p_appointment_id uuid)
returns table (
  payment_id uuid,
  pay_status payment_status,
  pay_amount numeric,
  pay_paid_amount numeric,
  pay_method payment_method
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_professional_member_id uuid;
  v_caller_member_id uuid;
  v_caller_role member_role;
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
    raise exception 'Seu papel não permite ver este recebimento.' using errcode = '42501';
  end if;
  if v_caller_role = 'professional' and v_professional_member_id is distinct from v_caller_member_id then
    raise exception 'Você só pode ver atendimentos atribuídos a você.' using errcode = '42501';
  end if;

  return query
  select p.id, p.status, p.amount, p.paid_amount, p.method
  from payments p
  where p.appointment_id = p_appointment_id
  limit 1;
end;
$$;

revoke all on function get_appointment_payment(uuid) from public, anon;
grant execute on function get_appointment_payment(uuid) to authenticated;

-- 2. Alterar a forma de pagamento (e opcionalmente marcar como recebido) --------
-- ATUALIZA o pagamento existente; nunca cria um segundo (a 0010 também impede).
-- Mexe somente em method (e, se pedido, status/paid_amount/paid_at). Valor,
-- cliente e vínculo com o atendimento não mudam.
create or replace function update_appointment_payment(
  p_appointment_id uuid,
  p_method payment_method,
  p_mark_received boolean default false
) returns void
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

  -- trava o atendimento (serializa com outra alteração/exclusão simultânea)
  select status into v_status from appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  if v_status <> 'concluido' then
    raise exception 'Só é possível alterar o recebimento de um atendimento concluído.' using errcode = '22023';
  end if;

  select id, status into v_payment_id, v_payment_status
  from payments
  where appointment_id = p_appointment_id
  for update;
  if v_payment_id is null then
    raise exception 'Este atendimento não tem recebimento registrado.' using errcode = 'P0002';
  end if;

  update payments set method = p_method where id = v_payment_id;
  update appointments set payment_method = p_method where id = p_appointment_id;

  -- pendente/parcial -> recebido. status, paid_amount e paid_at no MESMO UPDATE
  -- (o CHECK payments_paid_amount_consistency exige coerência entre eles).
  if p_mark_received and v_payment_status <> 'pago' then
    update payments
    set status = 'pago',
        paid_amount = amount,
        paid_at = coalesce(paid_at, now())
    where id = v_payment_id;
  end if;
end;
$$;

revoke all on function update_appointment_payment(uuid, payment_method, boolean) from public, anon;
grant execute on function update_appointment_payment(uuid, payment_method, boolean) to authenticated;

-- 3. Excluir atendimento concluído (e o recebimento dele) ------------------------
-- UMA transação: remove o(s) pagamento(s) do atendimento, remove o atendimento
-- e recalcula first/last_visit_at da cliente. Se qualquer passo falhar, nada
-- é feito. Só owner/admin (a mesma restrição de payments por RLS).
--
-- O que acontece com o histórico:
--   * appointment_status_history do atendimento é removido (FK ON DELETE CASCADE);
--   * audit_logs guarda quem excluiu e o registro completo de appointments e
--     payments ("before"), pelos gatilhos de auditoria já existentes;
--   * pagamentos de OUTROS atendimentos não são tocados.
create or replace function delete_appointment(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_client_id uuid;
  v_status appointment_status;
  v_caller_role member_role;
  v_payments_deleted integer;
  v_payment_amount numeric;
  v_payment_received numeric;
begin
  if auth.uid() is null then
    raise exception 'Não autenticado.' using errcode = '28000';
  end if;

  -- "não existe" e "é de outra empresa" dão o MESMO erro (sem oráculo de ids)
  select company_id into v_company_id from appointments where id = p_appointment_id;
  if v_company_id is null or not is_company_member(v_company_id) then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;

  select role into v_caller_role
  from company_members
  where company_id = v_company_id and user_id = auth.uid() and active = true
  limit 1;
  if v_caller_role is null or v_caller_role not in ('owner', 'admin') then
    raise exception 'Somente a administração do negócio pode excluir atendimentos.' using errcode = '42501';
  end if;

  -- só depois de provar empresa e papel é que a linha é travada
  select client_id, status into v_client_id, v_status
  from appointments
  where id = p_appointment_id
  for update;
  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;

  if v_status <> 'concluido' then
    raise exception 'Só atendimentos concluídos podem ser excluídos. Para os demais, use Cancelar.' using errcode = '22023';
  end if;

  -- 1) recebimento(s) do atendimento (normalmente 1; a 0010 impede mais de 1)
  with d as (
    delete from payments
    where appointment_id = p_appointment_id
    returning amount, paid_amount
  )
  select count(*), coalesce(sum(amount), 0), coalesce(sum(paid_amount), 0)
  into v_payments_deleted, v_payment_amount, v_payment_received
  from d;

  -- 2) o atendimento (o gatilho do item 4 passa: não resta pagamento)
  delete from appointments where id = p_appointment_id;

  -- 3) first/last_visit_at são derivados dos atendimentos concluídos
  --    (conclude_appointment os grava com a data de conclusão em São Paulo).
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
    'payment_deleted', v_payments_deleted > 0,
    'payment_amount', v_payment_amount,
    'payment_received', v_payment_received
  );
end;
$$;

revoke all on function delete_appointment(uuid) from public, anon;
grant execute on function delete_appointment(uuid) to authenticated;

-- 4. Nunca deixar pagamento órfão -----------------------------------------------
-- A policy appointments_all (0001) deixa qualquer membro dar DELETE direto em
-- appointments. Com payments.appointment_id ON DELETE SET NULL, isso apagaria o
-- atendimento e DEIXARIA o valor no Financeiro, sem vínculo. Agora um DELETE de
-- atendimento que ainda tenha pagamento é recusado; delete_appointment() remove
-- o pagamento ANTES, então passa. Atendimentos sem pagamento (agendados,
-- cancelados) continuam podendo ser removidos como antes.
-- SECURITY DEFINER: payments é admin-only por RLS; sem isso quem não é admin
-- "enxergaria" 0 pagamentos e a exclusão passaria.
create or replace function prevent_appointment_delete_with_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from payments where appointment_id = old.id) then
    raise exception 'Este atendimento tem recebimento registrado. Use "Excluir atendimento" no app, que remove o recebimento junto.'
      using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger trg_appointments_block_delete_with_payment
  before delete on appointments
  for each row execute function prevent_appointment_delete_with_payment();

notify pgrst, 'reload schema';
