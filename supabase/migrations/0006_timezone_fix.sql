-- ---------------------------------------------------------------------------
-- Correção: cálculos de data usavam o fuso da sessão do Postgres (UTC, o
-- padrão do Supabase), não o fuso real do negócio (America/Sao_Paulo).
--
-- Efeito prático: um atendimento concluído/pago depois de ~21h (horário de
-- Brasília) tem created_at/scheduled_start cujo ::date, em UTC, já é o dia
-- SEGUINTE. Isso fazia esse valor cair fora do período "hoje" que a
-- profissional via na tela, e first_visit_at/last_visit_at (gravados com
-- current_date, também UTC) podiam registrar a data errada pelo mesmo motivo.
--
-- Correção: mesmas duas funções, mesma assinatura, só trocando os pontos que
-- calculavam "que dia é esse timestamp" para converter explicitamente para
-- America/Sao_Paulo antes de extrair a data. create or replace function não
-- altera tabela, RLS nem dado já gravado — só a lógica de cálculo daqui pra
-- frente.
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
  set last_visit_at = v_today,
      first_visit_at = coalesce(first_visit_at, v_today)
  where id = v_client_id;
end;
$$;

revoke all on function conclude_appointment(uuid, numeric, payment_method, payment_status, numeric, text) from public;
grant execute on function conclude_appointment(uuid, numeric, payment_method, payment_status, numeric, text) to authenticated;

create or replace function get_period_indicators(p_company_id uuid, p_start date, p_end date)
returns table (
  atendimentos_realizados bigint,
  faturado numeric,        -- valor total das receitas geradas no período (independente de já ter sido recebido)
  recebido numeric,        -- valor efetivamente pago, das receitas geradas no período
  despesas numeric,
  resultado_caixa numeric, -- recebido - despesas (fluxo de caixa real, não faturamento)
  pendente numeric,        -- saldo em aberto hoje (todas as receitas pendentes/parcelas, não só do período)
  cancelamentos bigint,
  faltas bigint,
  clientes_novas bigint,
  clientes_recorrentes bigint
)
language sql stable set search_path = public as $$
  with fat as (
    -- Mesma semântica da migration 0004 (faturado e recebido = lançamentos
    -- GERADOS no período); só o cálculo do "dia" passa a ser em Brasília.
    select
      coalesce(sum(amount), 0) as faturado,
      coalesce(sum(paid_amount), 0) as recebido
    from payments
    where company_id = p_company_id
      and (created_at at time zone 'America/Sao_Paulo')::date between p_start and p_end
  ),
  desp as (
    select coalesce(sum(amount), 0) as v
    from expenses
    where company_id = p_company_id
      and coalesce((paid_at at time zone 'America/Sao_Paulo')::date, due_date, (created_at at time zone 'America/Sao_Paulo')::date)
          between p_start and p_end
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
    where company_id = p_company_id
      and (scheduled_start at time zone 'America/Sao_Paulo')::date between p_start and p_end
  ),
  novas as (
    select count(*) as v from clients
    where company_id = p_company_id and first_visit_at between p_start and p_end
  ),
  recorrentes as (
    select count(distinct client_id) as v
    from appointments a1
    where a1.company_id = p_company_id and a1.status = 'concluido'
      and (a1.scheduled_start at time zone 'America/Sao_Paulo')::date between p_start and p_end
      and exists (
        select 1 from appointments a2
        where a2.client_id = a1.client_id and a2.company_id = p_company_id
          and a2.status = 'concluido'
          and (a2.scheduled_start at time zone 'America/Sao_Paulo')::date < p_start
      )
  )
  select
    ap.realizados, fat.faturado, fat.recebido, desp.v, (fat.recebido - desp.v), pend.v,
    ap.cancel, ap.faltas, novas.v, recorrentes.v
  from ap, fat, desp, pend, novas, recorrentes;
$$;
