-- ---------------------------------------------------------------------------
-- 0030 — Editar atendimento CONCLUÍDO + LANÇAMENTO RETROATIVO
--
-- Duas funções controladas (SECURITY DEFINER, só owner/admin). A trava da 0014
-- continua barrando edição DIRETA de concluído pela API; estas funções são o
-- caminho oficial, que mantém atendimento e recebimento coerentes na MESMA
-- transação (a checagem atendimento×recebimento da 0014 roda no fim dela).
--
-- edit_concluded_appointment: serviço, profissional, data/horário, valor,
--   status do recebimento (pago/pendente), forma de pagamento e observação.
--   * recebimento acompanha: valor, forma e status; se a DATA muda, o lançamento
--     passa para o dia novo no Financeiro (payments.created_at = fim do atendimento);
--   * parcial: ajuste pelo Financeiro (AUR03), como já era;
--   * concluído não vai para o futuro; conflito de horário segue a exclusion
--     constraint (23P01); outra pessoa alterou → AUE02.
--
-- create_retroactive_appointment: atendimento JÁ REALIZADO (início no passado),
--   registrado como concluído pela conclusão oficial (conclude_appointment), com
--   o recebimento lançado NA DATA DO ATENDIMENTO, e primeira/última visita da
--   cliente recalculadas pelas datas reais.
--
-- NENHUMA mensagem automática: a confirmação só sai para horário futuro, e os
-- avisos de alteração/cancelamento só para agendamento em aberto e futuro.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'update_appointment')
     or not exists (select 1 from pg_proc where proname = 'conclude_appointment') then
    raise exception '0030 ABORTADA — nada foi alterado. Aplique antes a 0022.' using errcode = '55000';
  end if;
end $$;

create or replace function edit_concluded_appointment(
  p_appointment_id uuid,
  p_service_id uuid,
  p_professional_member_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_price numeric,
  p_payment_status payment_status,
  p_method payment_method,
  p_notes text,
  p_expected jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  p payments%rowtype;
  v_role member_role;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_date_changed boolean;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into a from appointments where id = p_appointment_id for update;
  if not found or not is_company_member(a.company_id) then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  select role into v_role from company_members where company_id = a.company_id and user_id = auth.uid() and active limit 1;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa edita atendimento concluído.' using errcode = '42501';
  end if;
  if a.status <> 'concluido' then
    raise exception 'Este atendimento não está concluído. A tela foi atualizada.' using errcode = 'AUE01';
  end if;
  select * into p from payments where appointment_id = a.id for update;
  if not found then raise exception 'Este atendimento não tem recebimento registrado.' using errcode = 'P0002'; end if;

  if p_expected is null
     or (p_expected ->> 'service_id')::uuid is distinct from a.service_id
     or (p_expected ->> 'professional_member_id')::uuid is distinct from a.professional_member_id
     or (p_expected ->> 'scheduled_start')::timestamptz is distinct from a.scheduled_start
     or (p_expected ->> 'scheduled_end')::timestamptz is distinct from a.scheduled_end
     or (p_expected ->> 'price')::numeric is distinct from a.price
     or (p_expected ->> 'status') is distinct from a.status::text
     or (p_expected ->> 'payment_status') is distinct from p.status::text then
    raise exception 'Este atendimento foi alterado por outra pessoa. A tela foi atualizada.' using errcode = 'AUE02';
  end if;

  if p.status = 'parcial' then
    raise exception 'Este recebimento é parcial. Ajuste-o pelo Financeiro.' using errcode = 'AUR03';
  end if;
  if p_payment_status not in ('pago', 'pendente') or p_method is null then
    raise exception 'Escolha se foi pago ou está pendente, e a forma de pagamento.' using errcode = 'AUE06';
  end if;
  if p_scheduled_start is null or p_scheduled_end is null or p_scheduled_end <= p_scheduled_start
     or p_scheduled_end - p_scheduled_start > interval '24 hours' or p_price is null or p_price < 0 then
    raise exception 'Horário ou valor inválido.' using errcode = 'AUE06';
  end if;
  if p_scheduled_start > now() then
    raise exception 'Atendimento concluído não pode ficar com horário no futuro.' using errcode = 'AUE06';
  end if;
  if p_service_id is distinct from a.service_id and not exists (
       select 1 from services s where s.id = p_service_id and s.company_id = a.company_id and s.active) then
    raise exception 'Serviço inválido ou inativo.' using errcode = 'AUE04';
  end if;
  if p_professional_member_id is distinct from a.professional_member_id and not exists (
       select 1 from company_members m where m.id = p_professional_member_id and m.company_id = a.company_id and m.active) then
    raise exception 'Profissional inválida ou inativa.' using errcode = 'AUE05';
  end if;

  if (p_service_id, p_professional_member_id, p_scheduled_start, p_scheduled_end, p_price, v_notes, p_payment_status, p_method)
     is not distinct from
     (a.service_id, a.professional_member_id, a.scheduled_start, a.scheduled_end, a.price, a.notes, p.status, p.method) then
    return jsonb_build_object('changed', false);
  end if;

  v_date_changed := (p_scheduled_start at time zone 'America/Sao_Paulo')::date
                    <> (a.scheduled_start at time zone 'America/Sao_Paulo')::date;

  update appointments
  set service_id = p_service_id, professional_member_id = p_professional_member_id,
      scheduled_start = p_scheduled_start, scheduled_end = p_scheduled_end,
      price = p_price, payment_method = p_method, notes = v_notes
  where id = a.id;

  update payments
  set amount = p_price,
      method = p_method,
      status = p_payment_status,
      paid_amount = case when p_payment_status = 'pago' then p_price else 0 end,
      paid_at = case when p_payment_status = 'pago' then coalesce(p.paid_at, now()) else null end,
      created_at = case when v_date_changed then p_scheduled_end else p.created_at end
  where id = p.id;

  -- primeira/última visita da cliente pelas datas REAIS dos atendimentos concluídos
  if v_date_changed then
    update clients c
      set first_visit_at = v.first_d, last_visit_at = v.last_d
      from (select min((x.scheduled_start at time zone 'America/Sao_Paulo')::date) first_d,
                   max((x.scheduled_start at time zone 'America/Sao_Paulo')::date) last_d
            from appointments x where x.client_id = a.client_id and x.status = 'concluido') v
      where c.id = a.client_id and v.first_d is not null;
  end if;

  return jsonb_build_object('changed', true, 'date_changed', v_date_changed);
end;
$$;

create or replace function create_retroactive_appointment(
  p_company_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_professional_member_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_price numeric,
  p_payment_status payment_status,
  p_method payment_method,
  p_notes text)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  if not is_company_member(p_company_id) then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  select role into v_role from company_members where company_id = p_company_id and user_id = auth.uid() and active limit 1;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa faz lançamento retroativo.' using errcode = '42501';
  end if;
  if p_scheduled_start is null or p_scheduled_end is null or p_scheduled_end <= p_scheduled_start
     or p_scheduled_end - p_scheduled_start > interval '24 hours' or p_price is null or p_price < 0 then
    raise exception 'Horário ou valor inválido.' using errcode = 'AUE06';
  end if;
  if p_scheduled_start >= now() then
    raise exception 'Lançamento retroativo é só para atendimento que já aconteceu.' using errcode = 'AUE06';
  end if;
  if p_payment_status not in ('pago', 'pendente') or p_method is null then
    raise exception 'Escolha se foi pago ou está pendente, e a forma de pagamento.' using errcode = 'AUE06';
  end if;
  if not exists (select 1 from clients c where c.id = p_client_id and c.company_id = p_company_id and c.archived_at is null) then
    raise exception 'Cliente inválida para esta empresa.' using errcode = 'AUE03';
  end if;
  if not exists (select 1 from services s where s.id = p_service_id and s.company_id = p_company_id and s.active) then
    raise exception 'Serviço inválido ou inativo.' using errcode = 'AUE04';
  end if;
  if not exists (select 1 from company_members m where m.id = p_professional_member_id and m.company_id = p_company_id and m.active) then
    raise exception 'Profissional inválida ou inativa.' using errcode = 'AUE05';
  end if;

  -- nasce no passado: o gatilho da confirmação automática não envia nada
  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end,
                            price, notes, created_by)
  values (p_company_id, p_client_id, p_service_id, p_professional_member_id, p_scheduled_start, p_scheduled_end,
          p_price, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;

  -- conclusão OFICIAL (mesmas regras e mesmo recebimento de sempre)
  perform conclude_appointment(v_id, p_price, p_method, p_payment_status);

  -- ...com as datas do atendimento, não as de hoje
  update appointments set completed_at = p_scheduled_end where id = v_id;
  update payments
  set created_at = p_scheduled_end,
      paid_at = case when status = 'pago' then p_scheduled_end else null end
  where appointment_id = v_id;
  -- primeira/última visita da cliente pelas datas REAIS dos atendimentos concluídos
  update clients c
      set first_visit_at = v.first_d, last_visit_at = v.last_d
      from (select min((x.scheduled_start at time zone 'America/Sao_Paulo')::date) first_d,
                   max((x.scheduled_start at time zone 'America/Sao_Paulo')::date) last_d
            from appointments x where x.client_id = p_client_id and x.status = 'concluido') v
      where c.id = p_client_id and v.first_d is not null;
  return v_id;
end;
$$;

revoke all on function edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb),
  create_retroactive_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text)
  from public, anon;
grant execute on function edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb),
  create_retroactive_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text)
  to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb),
      create_retroactive_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text)
      from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
