-- ---------------------------------------------------------------------------
-- 0022 — EDIÇÃO de agendamento (cliente, serviço, profissional, data/horário,
-- duração, valor, observação)
--
-- Uma função, update_appointment, que roda com as permissões de QUEM CHAMA
-- (SECURITY INVOKER): a policy appointments_all (RLS), a trava da 0014 (concluído
-- é imutável) e a exclusion constraint no_overlap_per_professional continuam
-- sendo as autoridades. Nada disso é enfraquecido.
--
--   * Só agendamento EM ABERTO (agendado | confirmado | em_atendimento).
--   * Trava a linha (FOR UPDATE) e confere que nada mudou desde que a tela
--     abriu (p_expected). Se outra pessoa alterou, recusa (AUE02) em vez de
--     sobrescrever em silêncio.
--   * Conflito de horário: a exclusion constraint recusa (23P01), inclusive
--     entre duas edições simultâneas.
--   * Cliente/serviço/profissional novos precisam ser da MESMA empresa e
--     estar ativos; o que não mudou é aceito como está (registro antigo).
--   * Duração e valor: a tela usa os padrões do serviço quando o serviço muda
--     (mesma regra da criação); sem troca de serviço, mantém os valores do
--     próprio agendamento. A função grava o que foi confirmado na tela.
--   * Não muda status, recebimentos nem histórico de status.
--
-- Erros (para a tela): AUE01 não está em aberto · AUE02 alterado por outra
-- pessoa · AUE03 cliente inválida · AUE04 serviço inválido · AUE05 profissional
-- inválida · AUE06 horário/valor inválido · 23P01 conflito · P0002 não encontrado.
-- ---------------------------------------------------------------------------

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
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
