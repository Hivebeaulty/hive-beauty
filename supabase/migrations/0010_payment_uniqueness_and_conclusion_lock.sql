-- ---------------------------------------------------------------------------
-- 0010 — Um atendimento, no máximo UM pagamento (e conclusão serializada)
--
-- Contexto: o novo fluxo registra o atendimento realizado com um único toque.
-- conclude_appointment lia o status SEM travar a linha e não havia unicidade em
-- payments.appointment_id; duas chamadas simultâneas (duplo toque, dois
-- aparelhos) podiam gerar dois pagamentos para o mesmo atendimento.
--
--   1. ÍNDICE ÚNICO parcial em payments(appointment_id): rede de segurança no
--      banco, vale para qualquer caminho (RPC, API, SQL). Pagamentos SEM
--      atendimento (receita avulsa) continuam ilimitados.
--   2. conclude_appointment: mesma assinatura, mesmas regras e mesmos erros; a
--      única mudança de lógica é travar a linha do atendimento (FOR UPDATE) e
--      reler o status DEPOIS da trava. A 2ª chamada espera a 1ª e então falha
--      limpo com "já foi encerrado" (22023), em vez de duplicar.
--
-- Não altera dados, RLS, constraints existentes, nem migrations anteriores.
-- Pagamentos históricos ficam exatamente como estão.
-- ---------------------------------------------------------------------------

-- 0. PREFLIGHT: aborta (sem alterar nada) se já existir atendimento com mais
-- de um pagamento. NÃO corrige dados automaticamente.
do $$
declare
  v_dup bigint;
begin
  select count(*) into v_dup from (
    select appointment_id
    from payments
    where appointment_id is not null
    group by appointment_id
    having count(*) > 1
  ) d;

  if v_dup > 0 then
    raise exception '0010 ABORTADA — nada foi alterado. Existem % atendimento(s) com mais de um pagamento. Liste-os com: select appointment_id, count(*) from payments where appointment_id is not null group by 1 having count(*) > 1;', v_dup
      using errcode = '23505';
  end if;
end $$;

-- 1. UM pagamento por atendimento
create unique index payments_appointment_id_unique
  on payments (appointment_id)
  where appointment_id is not null;

-- 2. conclude_appointment com trava de linha -----------------------------------
-- Cópia fiel da versão vigente (0006). Diferenças, e somente estas:
--   * a checagem de status (e) agora lê com FOR UPDATE, depois de provar que a
--     pessoa é membro/tem papel (para não-membros nunca travarem linha alheia);
--   * search_path = public, pg_temp (pg_temp por último: uma tabela temporária
--     chamada "payments" não pode mais receber o INSERT no lugar da real).
create or replace function conclude_appointment(
  p_appointment_id uuid,
  p_final_price numeric,
  p_method payment_method,
  p_payment_status payment_status default 'pago',
  p_paid_amount numeric default null,
  p_note text default null
) returns void
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
  v_paid_amount numeric;
  v_today date;
begin
  -- "hoje" no fuso do negócio (America/Sao_Paulo), não no fuso da sessão do Postgres (UTC).
  v_today := (now() at time zone 'America/Sao_Paulo')::date;

  -- (a) usuário autenticado
  if auth.uid() is null then
    raise exception 'Não autenticado.' using errcode = '28000';
  end if;

  -- (b) atendimento existente + qual é a empresa dele
  select company_id, client_id, professional_member_id, status
  into v_company_id, v_client_id, v_professional_member_id, v_status
  from appointments
  where id = p_appointment_id;

  if v_company_id is null then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;

  -- (c) membership ativa na empresa do atendimento
  if not is_company_member(v_company_id) then
    raise exception 'Você não tem acesso a esta empresa.' using errcode = '42501';
  end if;

  select id, role into v_caller_member_id, v_caller_role
  from company_members
  where company_id = v_company_id and user_id = auth.uid() and active = true
  limit 1;

  -- (d) papel/permissão: reception não realiza atendimento, então não conclui
  if v_caller_role is null or v_caller_role not in ('owner', 'admin', 'professional') then
    raise exception 'Seu papel não permite concluir atendimentos.' using errcode = '42501';
  end if;

  -- profissional só conclui o que é seu; owner/admin podem concluir qualquer
  -- atendimento da empresa (supervisão administrativa)
  if v_caller_role = 'professional' and v_professional_member_id is distinct from v_caller_member_id then
    raise exception 'Você só pode concluir atendimentos atribuídos a você.' using errcode = '42501';
  end if;

  -- (e) possibilidade de concluir: não pode já estar encerrado.
  -- NOVO: trava a linha e relê o status. Se outra chamada estiver concluindo
  -- este mesmo atendimento, esperamos ela terminar e então vemos 'concluido'.
  select status into v_status
  from appointments
  where id = p_appointment_id
  for update;

  if not found then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;

  if v_status in ('concluido', 'cancelado', 'nao_compareceu') then
    raise exception 'Este atendimento já foi encerrado e não pode ser concluído novamente.' using errcode = '22023';
  end if;

  v_paid_amount := coalesce(
    p_paid_amount,
    case p_payment_status when 'pago' then p_final_price when 'pendente' then 0 else 0 end
  );

  update appointments
  set status = 'concluido',
      price = p_final_price,
      payment_method = p_method,
      completed_at = now(),
      notes = coalesce(p_note, notes)
  where id = p_appointment_id;

  -- paid_amount também é normalizado pelo trigger da tabela — dupla checagem
  -- proposital, a RPC não é a única linha de defesa.
  insert into payments (company_id, appointment_id, client_id, amount, paid_amount, method, status, paid_at)
  values (
    v_company_id, p_appointment_id, v_client_id, p_final_price, v_paid_amount, p_method, p_payment_status,
    case when p_payment_status = 'pago' then now() else null end
  );

  update clients
  set last_visit_at = v_today,
      first_visit_at = coalesce(first_visit_at, v_today)
  where id = v_client_id;
end;
$$;

revoke all on function conclude_appointment(uuid, numeric, payment_method, payment_status, numeric, text) from public, anon;
grant execute on function conclude_appointment(uuid, numeric, payment_method, payment_status, numeric, text) to authenticated;

notify pgrst, 'reload schema';
