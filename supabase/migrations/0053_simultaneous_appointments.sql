-- ---------------------------------------------------------------------------
-- 0053 — MAIS DE UMA CLIENTE NO MESMO HORÁRIO (opcional, por profissional)
--
-- Hoje a exclusion constraint no_overlap_per_professional (0001) recusa dois
-- atendimentos abertos da mesma profissional que se sobreponham. Esta migration
-- deixa a profissional escolher, nas Configurações, se aceita agendar junto.
-- DESLIGADO por padrão: quem não ligar vê exatamente o comportamento de hoje.
--
-- Como funciona
--   * member_scheduling_prefs.allow_simultaneous (por membro, padrão false).
--     Tabela fechada para a API; leitura e escrita só por funções.
--   * appointments.overlap_ok marca o atendimento "agendado junto". A exclusion
--     constraint é recriada ignorando os marcados; para os demais ela segue igual
--     (continua protegendo contra duas gravações ao mesmo tempo).
--   * Um gatilho BEFORE decide cada gravação que muda horário/profissional/status:
--       - sem conflito                         -> grava (e zera overlap_ok);
--       - com conflito, opção desligada         -> recusa 23P01 (igual a hoje);
--       - com conflito, opção ligada, sem o "sim" da profissional -> AOV01
--         (a tela abre a pergunta "agendar junto?");
--       - com conflito, opção ligada, overlap_ok = true -> grava.
--     Mexer só em status/pagamento/observação de um atendimento já marcado NÃO
--     reavalia nada (desligar a opção depois não trava atendimentos existentes).
--   * create_appointment_with_extras e update_appointment ganham
--     p_allow_overlap (padrão false): o app antigo continua funcionando.
--
-- Erros (para a tela): AOV01 já existe atendimento nesse horário, confirme ·
-- 23P01 horário ocupado (como antes).
--
-- Reversão: supabase/operations/0053_reversao.sql
-- ---------------------------------------------------------------------------

-- 1. Preferência por profissional (fechada para a API, como push_prefs) -------------------------
create table if not exists member_scheduling_prefs (
  member_id          uuid primary key references company_members(id) on delete cascade,
  allow_simultaneous boolean not null default false,
  updated_at         timestamptz not null default now()
);
alter table member_scheduling_prefs enable row level security;
revoke all on member_scheduling_prefs from public, anon, authenticated;

-- A profissional lê e grava a PRÓPRIA preferência.
create or replace function get_my_allow_simultaneous(p_member_id uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not exists (select 1 from company_members m where m.id = p_member_id and m.user_id = auth.uid() and m.active) then
    raise exception 'Sem permissão';
  end if;
  select p.allow_simultaneous into v from member_scheduling_prefs p where p.member_id = p_member_id;
  return coalesce(v, false);
end;
$$;

create or replace function set_my_allow_simultaneous(p_member_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if p_enabled is null then raise exception 'Valor inválido'; end if;
  if not exists (select 1 from company_members m where m.id = p_member_id and m.user_id = auth.uid() and m.active) then
    raise exception 'Sem permissão';
  end if;
  insert into member_scheduling_prefs (member_id, allow_simultaneous, updated_at)
  values (p_member_id, p_enabled, now())
  on conflict (member_id) do update set allow_simultaneous = excluded.allow_simultaneous, updated_at = now();
end;
$$;

-- Quem agenda precisa saber se a profissional ESCOLHIDA aceita agendar junto
-- (pode ser outra pessoa da equipe). Só membros da mesma empresa.
create or replace function member_allows_simultaneous(p_member_id uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not exists (
    select 1 from company_members t
    join company_members me on me.company_id = t.company_id and me.user_id = auth.uid() and me.active
    where t.id = p_member_id
  ) then
    raise exception 'Sem permissão';
  end if;
  select p.allow_simultaneous into v from member_scheduling_prefs p where p.member_id = p_member_id;
  return coalesce(v, false);
end;
$$;

revoke all on function get_my_allow_simultaneous(uuid) from public, anon;
revoke all on function set_my_allow_simultaneous(uuid, boolean) from public, anon;
revoke all on function member_allows_simultaneous(uuid) from public, anon;
grant execute on function get_my_allow_simultaneous(uuid) to authenticated;
grant execute on function set_my_allow_simultaneous(uuid, boolean) to authenticated;
grant execute on function member_allows_simultaneous(uuid) to authenticated;

-- 2. Marca do atendimento "agendado junto" + constraint que ignora os marcados -------------------
alter table appointments add column if not exists overlap_ok boolean not null default false;

alter table appointments drop constraint if exists no_overlap_per_professional;
alter table appointments add constraint no_overlap_per_professional
  exclude using gist (
    professional_member_id with =,
    tstzrange(scheduled_start, scheduled_end) with &&
  ) where (status not in ('cancelado', 'nao_compareceu') and not overlap_ok);

-- 3. Gatilho que decide cada gravação ------------------------------------------------------------
create or replace function appointments_overlap_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conflict boolean;
  v_allows   boolean;
begin
  -- Cancelado / não compareceu não ocupa horário.
  if NEW.status in ('cancelado', 'nao_compareceu') then
    return NEW;
  end if;

  -- Atualização que não mexe em horário, profissional nem "volta a ocupar": não reavalia.
  if TG_OP = 'UPDATE'
     and NEW.scheduled_start is not distinct from OLD.scheduled_start
     and NEW.scheduled_end is not distinct from OLD.scheduled_end
     and NEW.professional_member_id is not distinct from OLD.professional_member_id
     and OLD.status not in ('cancelado', 'nao_compareceu')
     and NEW.overlap_ok is not distinct from OLD.overlap_ok then
    return NEW;
  end if;

  select exists (
    select 1 from appointments o
    where o.professional_member_id = NEW.professional_member_id
      and o.id is distinct from NEW.id
      and o.status not in ('cancelado', 'nao_compareceu')
      and tstzrange(o.scheduled_start, o.scheduled_end) && tstzrange(NEW.scheduled_start, NEW.scheduled_end)
  ) into v_conflict;

  if not v_conflict then
    NEW.overlap_ok := false;  -- a marca só existe enquanto há de fato outro atendimento no horário
    return NEW;
  end if;

  select coalesce(p.allow_simultaneous, false) into v_allows
  from member_scheduling_prefs p where p.member_id = NEW.professional_member_id;
  v_allows := coalesce(v_allows, false);

  if not v_allows then
    raise exception 'Esse horário já está ocupado por outro atendimento da profissional.' using errcode = '23P01';
  end if;
  if not NEW.overlap_ok then
    raise exception 'Já existe atendimento nesse horário. Confirme para agendar junto.' using errcode = 'AOV01';
  end if;
  return NEW;
end;
$$;

revoke all on function appointments_overlap_guard() from public, anon, authenticated;

drop trigger if exists trg_appointments_overlap_guard on appointments;
create trigger trg_appointments_overlap_guard
  before insert or update on appointments
  for each row execute function appointments_overlap_guard();

-- 4. Funções de agendar e editar ganham p_allow_overlap -------------------------------------------
drop function if exists create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb);
create or replace function create_appointment_with_extras(
  p_company_id uuid, p_client_id uuid, p_service_id uuid, p_professional_member_id uuid,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_price numeric, p_notes text, p_extras jsonb,
  p_allow_overlap boolean default false)
returns uuid
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end,
                            price, notes, created_by, overlap_ok)
  values (p_company_id, p_client_id, p_service_id, p_professional_member_id, p_scheduled_start, p_scheduled_end,
          p_price, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid(), coalesce(p_allow_overlap, false))
  returning id into v_id;
  perform set_appointment_extra_services(v_id, coalesce(p_extras, '[]'::jsonb));
  return v_id;
end;
$$;
revoke all on function create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean) from public, anon;
grant execute on function create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean) from service_role;
  end if;
end $$;

drop function if exists update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb);
create or replace function update_appointment(
  p_appointment_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_professional_member_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_price numeric,
  p_notes text,
  p_expected jsonb,
  p_allow_overlap boolean default false)
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

  select * into a from appointments where id = p_appointment_id for update;
  if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0002'; end if;

  if a.status not in ('agendado', 'confirmado', 'em_atendimento') then
    raise exception 'Só agendamentos em aberto podem ser editados.' using errcode = 'AUE01';
  end if;

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

  if (p_client_id, p_service_id, p_professional_member_id, p_scheduled_start, p_scheduled_end, p_price, v_notes)
     is not distinct from
     (a.client_id, a.service_id, a.professional_member_id, a.scheduled_start, a.scheduled_end, a.price, a.notes) then
    return jsonb_build_object('changed', false);
  end if;

  -- Só o "sim" explícito da profissional (p_allow_overlap) marca o atendimento como agendado junto;
  -- o gatilho confere que ela aceita isso e que há mesmo outro atendimento no horário.
  update appointments
  set client_id = p_client_id, service_id = p_service_id, professional_member_id = p_professional_member_id,
      scheduled_start = p_scheduled_start, scheduled_end = p_scheduled_end, price = p_price, notes = v_notes,
      overlap_ok = case
        when p_scheduled_start is distinct from a.scheduled_start
          or p_scheduled_end is distinct from a.scheduled_end
          or p_professional_member_id is distinct from a.professional_member_id
        then coalesce(p_allow_overlap, false)
        else a.overlap_ok          -- só nome, valor ou observação mudaram: a marca fica como está
      end
  where id = a.id;

  return jsonb_build_object(
    'changed', true,
    'rescheduled', p_scheduled_start is distinct from a.scheduled_start or p_service_id is distinct from a.service_id,
    'client_changed', p_client_id is distinct from a.client_id);
end;
$$;
revoke all on function update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean) from public, anon;
grant execute on function update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb, boolean) from service_role;
  end if;
end $$;
