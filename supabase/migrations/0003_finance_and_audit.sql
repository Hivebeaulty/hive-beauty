-- ============================================================================
-- HIVE BEAUTY — FASE 3: atendimento avançado, financeiro, indicadores, auditoria
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ESTRUTURA: campos novos
-- ---------------------------------------------------------------------------

-- horário real de conclusão (pode diferir do horário agendado)
alter table appointments add column completed_at timestamptz;

-- "outros recebimentos" (receita sem atendimento vinculado) precisam de uma
-- descrição; pagamento parcial precisa saber quanto já entrou de fato.
alter table payments add column description text;
alter table payments add column paid_amount numeric(10, 2);

-- ---------------------------------------------------------------------------
-- 2. CONCLUSÃO DE ATENDIMENTO — assinatura estendida (mantém 1 transação)
-- ---------------------------------------------------------------------------
drop function if exists conclude_appointment(uuid, numeric, payment_method, payment_status, text);

create function conclude_appointment(
  p_appointment_id uuid,
  p_final_price numeric,
  p_method payment_method,
  p_payment_status payment_status default 'pago',
  p_paid_amount numeric default null,
  p_note text default null
) returns void
language plpgsql set search_path = public as $$
declare
  v_client_id uuid;
  v_company_id uuid;
  v_paid_amount numeric;
begin
  select company_id, client_id into v_company_id, v_client_id
  from appointments where id = p_appointment_id;

  if v_client_id is null then
    raise exception 'Agendamento não encontrado ou sem acesso.';
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

-- ---------------------------------------------------------------------------
-- 3. CRIAÇÃO DE EMPRESA — agora também semeia categorias de despesa padrão
-- ---------------------------------------------------------------------------
create or replace function create_company_with_owner(company_name text, niche_slug text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_company_id uuid;
  target_niche_id uuid;
begin
  select id into target_niche_id from niches where slug = niche_slug;

  insert into companies (name, niche_id) values (company_name, target_niche_id)
  returning id into new_company_id;

  insert into company_members (company_id, user_id, role)
  values (new_company_id, auth.uid(), 'owner');

  insert into expense_categories (company_id, name)
  select new_company_id, c
  from unnest(array['Materiais', 'Produtos', 'Aluguel', 'Equipamentos', 'Comissão', 'Marketing', 'Outros']) as c;

  return new_company_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS — financeiro é sensível: só owner/admin, não qualquer membro
-- ---------------------------------------------------------------------------
drop policy if exists "payments_all" on payments;
drop policy if exists "expenses_all" on expenses;
drop policy if exists "expense_categories_all" on expense_categories;

create policy "payments_admin_only" on payments for all
  using (is_company_admin(company_id)) with check (is_company_admin(company_id));
create policy "expenses_admin_only" on expenses for all
  using (is_company_admin(company_id)) with check (is_company_admin(company_id));
create policy "expense_categories_admin_only" on expense_categories for all
  using (is_company_admin(company_id)) with check (is_company_admin(company_id));

-- ---------------------------------------------------------------------------
-- 5. INDICADORES POR PERÍODO (usado no Financeiro; base para a Fase 4)
-- Roda com os privilégios de quem chama -> um profissional sem acesso
-- financeiro recebe 0 em faturamento/despesas/pendente (bloqueado pelo RLS
-- acima), mas continua vendo atendimentos/clientes normalmente.
-- ---------------------------------------------------------------------------
create function get_period_indicators(p_company_id uuid, p_start date, p_end date)
returns table (
  atendimentos_realizados bigint,
  faturamento numeric,
  despesas numeric,
  resultado numeric,
  pendente numeric,
  cancelamentos bigint,
  faltas bigint,
  clientes_novas bigint,
  clientes_recorrentes bigint
)
language sql stable set search_path = public as $$
  with fat as (
    select coalesce(sum(coalesce(paid_amount, case when status = 'pago' then amount else 0 end)), 0) as v
    from payments
    where company_id = p_company_id and created_at::date between p_start and p_end
  ),
  desp as (
    select coalesce(sum(amount), 0) as v
    from expenses
    where company_id = p_company_id and coalesce(paid_at::date, due_date, created_at::date) between p_start and p_end
  ),
  pend as (
    select coalesce(sum(amount - coalesce(paid_amount, 0)), 0) as v
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
  select ap.realizados, fat.v, desp.v, (fat.v - desp.v), pend.v, ap.cancel, ap.faltas, novas.v, recorrentes.v
  from ap, fat, desp, pend, novas, recorrentes;
$$;

-- ---------------------------------------------------------------------------
-- 6. AUDITORIA AUTOMÁTICA (gatilho, não depende do frontend lembrar de logar)
-- SECURITY DEFINER de propósito: audit_logs não tem policy de INSERT para
-- usuários comuns, então a única forma de gravar auditoria é por este
-- gatilho — evita que alguém insira/forje entradas de auditoria diretamente.
-- ---------------------------------------------------------------------------
create function log_audit_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_company_id uuid;
begin
  v_company_id := coalesce(new.company_id, old.company_id);

  insert into audit_logs (company_id, user_id, action, entity, entity_id, metadata)
  values (
    v_company_id,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(new.id, old.id),
    case tg_op
      when 'DELETE' then jsonb_build_object('before', to_jsonb(old))
      when 'INSERT' then jsonb_build_object('after', to_jsonb(new))
      else jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new))
    end
  );

  return coalesce(new, old);
end;
$$;

create trigger trg_audit_clients after insert or update or delete on clients
  for each row execute function log_audit_change();
create trigger trg_audit_services after insert or update or delete on services
  for each row execute function log_audit_change();
create trigger trg_audit_expenses after insert or update or delete on expenses
  for each row execute function log_audit_change();
create trigger trg_audit_payments after insert or update or delete on payments
  for each row execute function log_audit_change();
create trigger trg_audit_appointments after insert or update or delete on appointments
  for each row execute function log_audit_change();
create trigger trg_audit_members after insert or update or delete on company_members
  for each row execute function log_audit_change();
