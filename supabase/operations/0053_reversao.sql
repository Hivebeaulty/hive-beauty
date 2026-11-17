-- Reversão da 0053 (horários simultâneos). SÓ rode com autorização.
-- Antes: não pode existir atendimento aberto "agendado junto" (overlap_ok = true), porque a constraint
-- original voltaria a recusá-los. A trava abaixo para tudo se houver algum.
begin;

do $$
begin
  if exists (select 1 from appointments where overlap_ok and status not in ('cancelado', 'nao_compareceu')) then
    raise exception 'Existem atendimentos agendados junto. Remarque ou cancele um deles antes de reverter a 0053.';
  end if;
end $$;

drop trigger if exists trg_appointments_overlap_guard on appointments;
drop function if exists appointments_overlap_guard();

alter table appointments drop constraint if exists no_overlap_per_professional;
alter table appointments add constraint no_overlap_per_professional
  exclude using gist (
    professional_member_id with =,
    tstzrange(scheduled_start, scheduled_end) with &&
  ) where (status not in ('cancelado', 'nao_compareceu'));
alter table appointments drop column if exists overlap_ok;

-- funções de volta às assinaturas de antes (0022 e 0033)
drop function if exists create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean);
create or replace function create_appointment_with_extras(
  p_company_id uuid, p_client_id uuid, p_service_id uuid, p_professional_member_id uuid,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_price numeric, p_notes text, p_extras jsonb)
returns uuid
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end,
                            price, notes, created_by)
  values (p_company_id, p_client_id, p_service_id, p_professional_member_id, p_scheduled_start, p_scheduled_end,
          p_price, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;
  perform set_appointment_extra_services(v_id, coalesce(p_extras, '[]'::jsonb));
  return v_id;
end;
$$;
revoke all on function create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) from public, anon;
grant execute on function create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) to authenticated;

drop function if exists update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean);
create or replace function update_appointment(
  p_appointment_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_professional_member_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_price numeric,
  p_notes text,
  p_expected jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;

  -- RLS: só enxerga agendamentos da própria empresa
  select * into a from appointments where id = p_appointment_id for update;
  if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0002'; end if;

  if a.status not in ('agendado', 'confirmado', 'em_atendimento') then
    raise exception 'Só agendamentos em aberto podem ser editados.' using errcode = 'AUE01';
  end if;

  -- alterado por outra pessoa desde que a tela abriu?
  if p_expected is null
     or (p_expected ->> 'client_id')::uuid is distinct from a.client_id
     or (p_expected ->> 'service_id')::uuid is distinct from a.service_id
     or (p_expected ->> 'professional_member_id')::uuid is distinct from a.professional_member_id
     or (p_expected ->> 'scheduled_start')::timestamptz is distinct from a.scheduled_start
     or (p_expected ->> 'scheduled_end')::timestamptz is distinct from a.scheduled_end
     or (p_expected ->> 'price')::numeric is distinct from a.price
     or (p_expected ->> 'status') is distinct from a.status::text then
    raise exception 'Este agendamento foi alterado por outra pessoa. A tela foi atualizada.' using errcode = 'AUE02';
  end if;

  if p_scheduled_start is null or p_scheduled_end is null or p_scheduled_end <= p_scheduled_start
     or p_scheduled_end - p_scheduled_start > interval '24 hours'
     or p_price is null or p_price < 0 then
    raise exception 'Horário ou valor inválido.' using errcode = 'AUE06';
  end if;

  if p_client_id is distinct from a.client_id and not exists (
       select 1 from clients c where c.id = p_client_id and c.company_id = a.company_id and c.archived_at is null) then
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

  -- nada mudou: não grava (nem dispara nada)
  if (p_client_id, p_service_id, p_professional_member_id, p_scheduled_start, p_scheduled_end, p_price, v_notes)
     is not distinct from
     (a.client_id, a.service_id, a.professional_member_id, a.scheduled_start, a.scheduled_end, a.price, a.notes) then
    return jsonb_build_object('changed', false);
  end if;

  update appointments
  set client_id = p_client_id, service_id = p_service_id, professional_member_id = p_professional_member_id,
      scheduled_start = p_scheduled_start, scheduled_end = p_scheduled_end, price = p_price, notes = v_notes
  where id = a.id;

  return jsonb_build_object(
    'changed', true,
    'rescheduled', p_scheduled_start is distinct from a.scheduled_start or p_service_id is distinct from a.service_id,
    'client_changed', p_client_id is distinct from a.client_id);
end;
$$;

revoke all on function update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) from public, anon;
grant execute on function update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) to authenticated;

drop function if exists get_my_allow_simultaneous(uuid);
drop function if exists set_my_allow_simultaneous(uuid, boolean);
drop function if exists member_allows_simultaneous(uuid);
drop table if exists member_scheduling_prefs;

commit;
