-- ---------------------------------------------------------------------------
-- 0034 — Corrigir a CLIENTE de um atendimento concluído (lançamento errado)
--
-- edit_concluded_appointment (0030) ganha p_client_id (opcional, no FIM: as telas
-- antigas continuam funcionando). Ao trocar a cliente:
--   * atendimento e recebimento mudam JUNTOS (o banco exige a mesma cliente nos dois);
--   * primeira/última visita recalculadas para as DUAS clientes;
--   * mesma empresa e não arquivada (AUE03); só owner/admin (como já era);
--   * nenhuma mensagem: atendimento concluído não avisa ninguém.
-- O restante da função é a cópia exata da 0030.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'edit_concluded_appointment') then
    raise exception '0034 ABORTADA — nada foi alterado. Aplique antes a 0030.' using errcode = '55000';
  end if;
end $$;

drop function if exists edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb);

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
  p_expected jsonb,
  p_client_id uuid default null)
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
  v_client uuid;
  v_client_changed boolean;
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
     or (p_expected ? 'client_id' and (p_expected ->> 'client_id')::uuid is distinct from a.client_id)
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
  -- [0034] correção da CLIENTE (lançamento errado): mesma empresa e não arquivada
  v_client := coalesce(p_client_id, a.client_id);
  v_client_changed := v_client is distinct from a.client_id;
  if v_client_changed and not exists (
       select 1 from clients c where c.id = v_client and c.company_id = a.company_id and c.archived_at is null) then
    raise exception 'Cliente inválida para esta empresa.' using errcode = 'AUE03';
  end if;
  if p_service_id is distinct from a.service_id and not exists (
       select 1 from services s where s.id = p_service_id and s.company_id = a.company_id and s.active) then
    raise exception 'Serviço inválido ou inativo.' using errcode = 'AUE04';
  end if;
  if p_professional_member_id is distinct from a.professional_member_id and not exists (
       select 1 from company_members m where m.id = p_professional_member_id and m.company_id = a.company_id and m.active) then
    raise exception 'Profissional inválida ou inativa.' using errcode = 'AUE05';
  end if;

  if (v_client, p_service_id, p_professional_member_id, p_scheduled_start, p_scheduled_end, p_price, v_notes, p_payment_status, p_method)
     is not distinct from
     (a.client_id, a.service_id, a.professional_member_id, a.scheduled_start, a.scheduled_end, a.price, a.notes, p.status, p.method) then
    return jsonb_build_object('changed', false);
  end if;

  v_date_changed := (p_scheduled_start at time zone 'America/Sao_Paulo')::date
                    <> (a.scheduled_start at time zone 'America/Sao_Paulo')::date;

  update appointments
  set client_id = v_client, service_id = p_service_id, professional_member_id = p_professional_member_id,
      scheduled_start = p_scheduled_start, scheduled_end = p_scheduled_end,
      price = p_price, payment_method = p_method, notes = v_notes
  where id = a.id;

  update payments
  set amount = p_price,
      client_id = v_client,
      method = p_method,
      status = p_payment_status,
      paid_amount = case when p_payment_status = 'pago' then p_price else 0 end,
      paid_at = case when p_payment_status = 'pago' then coalesce(p.paid_at, now()) else null end,
      created_at = case when v_date_changed then p_scheduled_end else p.created_at end
  where id = p.id;

  -- primeira/última visita pelas datas REAIS: da cliente atual e, se trocou, da anterior
  if v_date_changed or v_client_changed then
    update clients c
      set first_visit_at = v.first_d, last_visit_at = v.last_d
      from (select x.client_id, min((x.scheduled_start at time zone 'America/Sao_Paulo')::date) first_d,
                   max((x.scheduled_start at time zone 'America/Sao_Paulo')::date) last_d
            from appointments x where x.client_id in (a.client_id, v_client) and x.status = 'concluido' group by x.client_id) v
      where c.id = v.client_id;
    if v_client_changed and not exists (select 1 from appointments x where x.client_id = a.client_id and x.status = 'concluido') then
      update clients set first_visit_at = null, last_visit_at = null where id = a.client_id;
    end if;
  end if;

  return jsonb_build_object('changed', true, 'date_changed', v_date_changed, 'client_changed', v_client_changed);
end;
$$;

revoke all on function edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb, uuid) from public, anon;
grant execute on function edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb, uuid) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb, uuid) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
