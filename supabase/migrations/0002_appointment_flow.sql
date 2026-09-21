-- ============================================================================
-- HIVE BEAUTY — FASE 2: fluxo de atendimento
-- ============================================================================

-- Registra automaticamente toda mudança de status de um agendamento no
-- histórico, incluindo a criação (status inicial). Evita que cada tela da
-- aplicação precise lembrar de inserir manualmente no histórico.
create function log_appointment_status_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    insert into appointment_status_history (appointment_id, status, changed_by)
    values (new.id, new.status, auth.uid());
  end if;
  return new;
end;
$$;

create trigger trg_log_appointment_status
  after insert or update on appointments
  for each row execute function log_appointment_status_change();

-- Conclui um atendimento em uma única transação: atualiza o agendamento,
-- registra o pagamento e atualiza a última visita da cliente. Sem
-- SECURITY DEFINER de propósito: roda com o papel de quem chama, então
-- continua protegida pelas mesmas policies de RLS de appointments/payments/
-- clients (defesa em profundidade).
create function conclude_appointment(
  p_appointment_id uuid,
  p_final_price numeric,
  p_method payment_method,
  p_payment_status payment_status default 'pago',
  p_note text default null
) returns void
language plpgsql set search_path = public as $$
declare
  v_client_id uuid;
  v_company_id uuid;
begin
  select company_id, client_id into v_company_id, v_client_id
  from appointments where id = p_appointment_id;

  if v_client_id is null then
    raise exception 'Agendamento não encontrado ou sem acesso.';
  end if;

  update appointments
  set status = 'concluido',
      price = p_final_price,
      payment_method = p_method,
      notes = coalesce(p_note, notes)
  where id = p_appointment_id;

  insert into payments (company_id, appointment_id, client_id, amount, method, status, paid_at)
  values (
    v_company_id, p_appointment_id, v_client_id, p_final_price, p_method, p_payment_status,
    case when p_payment_status = 'pago' then now() else null end
  );

  update clients
  set last_visit_at = current_date,
      first_visit_at = coalesce(first_visit_at, current_date)
  where id = v_client_id;
end;
$$;
