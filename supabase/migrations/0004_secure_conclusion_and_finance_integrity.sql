-- ============================================================================
-- HIVE BEAUTY — FASE 3 (CORREÇÃO): conclusão segura, integridade financeira,
-- separação entre faturado / recebido / pendente
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CONCLUSÃO DE ATENDIMENTO COMO OPERAÇÃO CONTROLADA NO SERVIDOR
--
-- Por que SECURITY DEFINER aqui: "payments" tem RLS restrito a owner/admin
-- (migração 0003), mas uma profissional precisa conseguir registrar o
-- pagamento do próprio atendimento ao concluí-lo. Em vez de abrir acesso
-- geral à tabela (o que violaria o princípio "profissional não acessa o
-- financeiro"), a função roda com privilégio elevado só para esta operação
-- pontual e específica, e faz toda a validação de permissão manualmente
-- ANTES de tocar em qualquer tabela — ou seja, o "SECURITY DEFINER" nunca é
-- alcançado por um usuário sem direito a concluir aquele atendimento.
-- ---------------------------------------------------------------------------
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
set search_path = public
as $$
declare
  v_company_id uuid;
  v_client_id uuid;
  v_professional_member_id uuid;
  v_status appointment_status;
  v_caller_member_id uuid;
  v_caller_role member_role;
  v_paid_amount numeric;
begin
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

  -- (e) possibilidade de concluir: não pode já estar encerrado
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

  -- paid_amount também é normalizado pelo trigger da tabela (item 2 abaixo) —
  -- dupla checagem proposital, a RPC não é a única linha de defesa.
  insert into payments (company_id, appointment_id, client_id, amount, paid_amount, method, status, paid_at)
  values (
    v_company_id, p_appointment_id, v_client_id, p_final_price, v_paid_amount, p_method, p_payment_status,
    case when p_payment_status = 'pago' then now() else null end
  );

  update clients
  set last_visit_at = current_date,
      first_visit_at = coalesce(first_visit_at, current_date)
  where id = v_client_id;
end;
$$;

-- só usuários autenticados (nunca "anon") podem chamar esta RPC específica
revoke all on function conclude_appointment(uuid, numeric, payment_method, payment_status, numeric, text) from public;
grant execute on function conclude_appointment(uuid, numeric, payment_method, payment_status, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. INTEGRIDADE DE PAGAMENTO NO BANCO (defesa mesmo contra chamada direta
-- à API do Supabase, não só via RPC/frontend)
-- ---------------------------------------------------------------------------

-- normaliza paid_amount conforme o status, sempre que a linha é gravada
create function normalize_payment_amount() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'pago' then
    new.paid_amount := new.amount;
  elsif new.status = 'pendente' then
    new.paid_amount := 0;
  elsif new.status = 'parcial' and new.paid_amount is null then
    raise exception 'Informe o valor já pago para um pagamento parcial.';
  end if;
  return new;
end;
$$;

create trigger trg_normalize_payment_amount
  before insert or update on payments
  for each row execute function normalize_payment_amount();

-- a constraint é a garantia final: vale mesmo se alguém pular o trigger de
-- alguma forma ou inserir via um caminho que não passamos por aqui
alter table payments alter column paid_amount set not null;
alter table payments add constraint payments_amount_nonnegative check (amount >= 0);
alter table payments add constraint payments_paid_amount_bounds check (paid_amount >= 0 and paid_amount <= amount);
alter table payments add constraint payments_status_consistency check (
  (status = 'pago' and paid_amount = amount) or
  (status = 'pendente' and paid_amount = 0) or
  (status = 'parcial' and paid_amount > 0 and paid_amount < amount)
);

-- ---------------------------------------------------------------------------
-- 3. INDICADORES — separar faturado (gerado) x recebido (caixa) x pendente
-- ---------------------------------------------------------------------------
drop function if exists get_period_indicators(uuid, date, date);

create function get_period_indicators(p_company_id uuid, p_start date, p_end date)
returns table (
  atendimentos_realizados bigint,
  faturado numeric,        -- valor total das receitas geradas no período (independente de já ter sido recebido)
  recebido numeric,        -- valor efetivamente pago, das receitas geradas no período
  despesas numeric,
  resultado_caixa numeric, -- recebido - despesas (fluxo de caixa real, não faturamento)
  pendente numeric,        -- saldo em aberto hoje (todas as receitas pendentes/parciais, não só do período)
  cancelamentos bigint,
  faltas bigint,
  clientes_novas bigint,
  clientes_recorrentes bigint
)
language sql stable set search_path = public as $$
  with fat as (
    select
      coalesce(sum(amount), 0) as faturado,
      coalesce(sum(paid_amount), 0) as recebido
    from payments
    where company_id = p_company_id and created_at::date between p_start and p_end
  ),
  desp as (
    select coalesce(sum(amount), 0) as v
    from expenses
    where company_id = p_company_id and coalesce(paid_at::date, due_date, created_at::date) between p_start and p_end
  ),
  pend as (
    select coalesce(sum(amount - paid_amount), 0) as v
    from payments
    where company_id = p_company_id and status in ('pendente', 'parcial')
  ),
  ap as (
    select
      count(*) filter (where status = 'concluido') as realizados,
      count(*) filter (where status = 'cancelado') as cancel,
      count(*) filter (where status = 'nao_compareceu') as faltas
    from appointments
    where company_id = p_company_id and scheduled_start::date between p_start and p_end
  ),
  novas as (
    select count(*) as v from clients
    where company_id = p_company_id and first_visit_at between p_start and p_end
  ),
  recorrentes as (
    select count(distinct client_id) as v
    from appointments a1
    where a1.company_id = p_company_id and a1.status = 'concluido'
      and a1.scheduled_start::date between p_start and p_end
      and exists (
        select 1 from appointments a2
        where a2.client_id = a1.client_id and a2.company_id = p_company_id
          and a2.status = 'concluido' and a2.scheduled_start::date < p_start
      )
  )
  select
    ap.realizados, fat.faturado, fat.recebido, desp.v, (fat.recebido - desp.v), pend.v,
    ap.cancel, ap.faltas, novas.v, recorrentes.v
  from ap, fat, desp, pend, novas, recorrentes;
$$;
