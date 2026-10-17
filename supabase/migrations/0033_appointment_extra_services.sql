-- ---------------------------------------------------------------------------
-- 0033 — VÁRIOS SERVIÇOS no mesmo atendimento
--
-- Desenho de menor impacto: o atendimento continua com o serviço PRINCIPAL
-- (appointments.service_id — tudo que já existe segue igual) e ganha serviços
-- ADICIONAIS (appointment_extra_services), cada um com valor e duração.
-- O valor e a duração do atendimento (appointments.price / horário) são a SOMA,
-- gravada pelas telas como hoje; o recebimento segue o valor do atendimento.
--
--   * create_appointment_with_extras: cria atendimento + adicionais NUMA transação
--     (SECURITY INVOKER: mesmas permissões/RLS da criação direta). A confirmação
--     automática já sai com todos os serviços (a fila refaz o texto na hora do envio).
--   * set_appointment_extra_services: troca a lista de adicionais de uma vez.
--     Em aberto: qualquer membro (como editar); concluído: só owner/admin (como a
--     0030); cancelado/falta: recusado. Serviço da mesma empresa e ativo (um que já
--     estava na lista pode ficar mesmo se foi desativado depois).
--   * whatsapp_private.appointment_services_label: "Manicure", "Manicure e Pedicure",
--     "Manicure, Pedicure e Esmaltação". As 4 funções de texto (confirmação do sistema
--     e própria, lembrete e avisos) passam a usar a lista — cópia EXATA das versões
--     vigentes, trocando só a linha do nome. Sem adicionais o texto é IDÊNTICO ao de hoje.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'edit_concluded_appointment') then
    raise exception '0033 ABORTADA — nada foi alterado. Aplique antes a 0030.' using errcode = '55000';
  end if;
end $$;

-- 1. TABELA --------------------------------------------------------------------------------
create table if not exists appointment_extra_services (
  id               uuid primary key default gen_random_uuid(),
  appointment_id   uuid not null references appointments (id) on delete cascade,
  company_id       uuid not null references companies (id) on delete cascade,
  service_id       uuid not null references services (id),
  price            numeric(10, 2) not null check (price >= 0),
  duration_minutes int not null check (duration_minutes between 1 and 1440),
  position         int not null default 1,
  created_at       timestamptz not null default now()
);
create index if not exists appt_extra_services_appt_idx on appointment_extra_services (appointment_id, position);
alter table appointment_extra_services enable row level security;
drop policy if exists appt_extra_services_read on appointment_extra_services;
create policy appt_extra_services_read on appointment_extra_services for select using (is_company_member(company_id));
-- gravação só pelas funções abaixo (sem policy de insert/update/delete)
revoke all on appointment_extra_services from public, anon;
grant select on appointment_extra_services to authenticated;

-- 2. LISTA DE SERVIÇOS ("A", "A e B", "A, B e C") ------------------------------------------
create or replace function whatsapp_private.appointment_services_label(p_appointment_id uuid)
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_names text[];
begin
  select array_agg(n order by o) into v_names from (
    select btrim(s.name) n, 0 o from appointments a join services s on s.id = a.service_id where a.id = p_appointment_id
    union all
    select btrim(s.name), e.position from appointment_extra_services e join services s on s.id = e.service_id
    where e.appointment_id = p_appointment_id
  ) z where n <> '';
  if v_names is null then return null; end if;
  if cardinality(v_names) = 1 then return v_names[1]; end if;
  return array_to_string(v_names[1:cardinality(v_names) - 1], ', ') || ' e ' || v_names[cardinality(v_names)];
end;
$$;

-- 3. GRAVAR ADICIONAIS -------------------------------------------------------------------------
create or replace function set_appointment_extra_services(p_appointment_id uuid, p_items jsonb)
returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_role member_role;
  it jsonb; i int := 0;
  v_service uuid; v_price numeric; v_dur int;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into a from appointments where id = p_appointment_id for update;
  if not found or not is_company_member(a.company_id) then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  select role into v_role from company_members where company_id = a.company_id and user_id = auth.uid() and active limit 1;
  if a.status in ('cancelado', 'nao_compareceu') then
    raise exception 'Este agendamento foi cancelado ou marcado como falta.' using errcode = 'AUE01';
  end if;
  if a.status = 'concluido' and (v_role is null or v_role not in ('owner', 'admin')) then
    raise exception 'Só a administração da empresa edita atendimento concluído.' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 10 then
    raise exception 'Lista de serviços inválida (até 10 adicionais).' using errcode = 'AUE06';
  end if;

  -- validação ANTES de mexer (tudo ou nada)
  for it in select * from jsonb_array_elements(p_items) loop
    v_service := (it ->> 'service_id')::uuid;
    v_price := (it ->> 'price')::numeric;
    v_dur := (it ->> 'duration_minutes')::int;
    if v_price is null or v_price < 0 or v_dur is null or v_dur < 1 or v_dur > 1440 then
      raise exception 'Valor ou duração inválidos em um dos serviços.' using errcode = 'AUE06';
    end if;
    if not exists (select 1 from services s where s.id = v_service and s.company_id = a.company_id
                   and (s.active or exists (select 1 from appointment_extra_services e
                                            where e.appointment_id = a.id and e.service_id = s.id))) then
      raise exception 'Serviço inválido ou inativo.' using errcode = 'AUE04';
    end if;
  end loop;

  delete from appointment_extra_services where appointment_id = a.id;
  for it in select * from jsonb_array_elements(p_items) loop
    i := i + 1;
    insert into appointment_extra_services (appointment_id, company_id, service_id, price, duration_minutes, position)
    values (a.id, a.company_id, (it ->> 'service_id')::uuid, (it ->> 'price')::numeric, (it ->> 'duration_minutes')::int, i);
  end loop;
  return i;
end;
$$;

-- 4. CRIAR COM ADICIONAIS (uma transação; permissões/RLS da criação direta) --------------------
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

-- 5. TEXTOS: cópias exatas, trocando só o nome do serviço pela lista -------------------------
create or replace function whatsapp_private.system_confirmation_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text;
  v_local timestamp; v_today date; v_day date;
  v_wd text; v_ddmm text; v_em text; v_para text; v_hora text;
  v_nome text; v_sv text; v_oi text; v_oitb text;
  v_hash bigint := 0; v_seed text; v_variant int; i int;
  v_greet text; v_body text;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return null; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  v_service := whatsapp_private.appointment_services_label(a.id);   -- [0033] todos os serviços

  -- dia: "no dia 15/10 (quinta-feira)" / "o dia 15/10 (quinta-feira)"; hoje/amanhã: "amanhã, quinta-feira (15/10)"
  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_day := v_local::date;
  v_today := (p_now at time zone 'America/Sao_Paulo')::date;
  v_wd := wd[extract(dow from v_local)::int + 1];
  v_ddmm := to_char(v_local, 'DD/MM');
  if v_day = v_today then
    v_em := 'hoje, ' || v_wd || ' (' || v_ddmm || ')'; v_para := v_em;
  elsif v_day = v_today + 1 then
    v_em := 'amanhã, ' || v_wd || ' (' || v_ddmm || ')'; v_para := v_em;
  else
    v_em := 'no dia ' || v_ddmm || ' (' || v_wd || ')';
    v_para := 'o dia ' || v_ddmm || ' (' || v_wd || ')';
  end if;
  v_hora := 'às ' || extract(hour from v_local)::int::text || 'h'
            || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;

  v_nome := nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], '');
  v_sv := btrim(coalesce(v_service, ''));
  v_oi := case when v_nome is not null then 'Oi, ' || v_nome || '!' else 'Oi!' end;
  v_oitb := case when v_nome is not null then 'Oi, ' || v_nome || ', tudo bem?' else 'Oi, tudo bem?' end;

  -- variação determinística: hash(id) % 8, igual ao JS ((h*31 + code) >>> 0)
  v_seed := a.id::text;
  for i in 1 .. char_length(v_seed) loop
    v_hash := (v_hash * 31 + ascii(substr(v_seed, i, 1))) % 4294967296;
  end loop;
  v_variant := (v_hash % 8)::int;

  case v_variant
    when 0 then v_greet := v_oi;
      v_body := 'Seu horário está confirmado! Te espero ' || v_em || ', ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. 💕';
    when 1 then v_greet := v_oi;
      v_body := 'Tudo certinho com o seu agendamento' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ': ficou para ' || v_para || ', ' || v_hora || '. Até lá!';
    when 2 then v_greet := v_oi;
      v_body := 'Agendamento confirmado! Vou te esperar ' || v_em || ', ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. ✨';
    when 3 then v_greet := v_oitb;
      v_body := 'Passando para confirmar o seu horário' || case when v_sv <> '' then ': ' || v_sv else '' end
                || ' ' || v_em || ', ' || v_hora || '. Qualquer imprevisto, é só me avisar por aqui.';
    when 4 then v_greet := v_oi;
      v_body := 'Seu horário' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ' está garantido para ' || v_para || ', ' || v_hora || '. Vou adorar te receber! 🌸';
    when 5 then v_greet := v_oi;
      v_body := 'Prontinho, seu horário está confirmado' || case when v_sv <> '' then ': ' || v_sv else '' end
                || ' ' || v_em || ', ' || v_hora || '. Se precisar remarcar, é só me chamar por aqui.';
    when 6 then v_greet := v_oitb;
      v_body := 'Seu agendamento' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ' está confirmado para ' || v_para || ', ' || v_hora || '. Te espero com carinho! 💕';
    else v_greet := v_oi;
      v_body := 'Só para confirmar: te espero ' || v_em || ', ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. Até breve!';
  end case;

  return v_greet || E'\n\n' || v_body;
end;
$$;

create or replace function whatsapp_private.custom_confirmation_text(p_appointment_id uuid, p_template text)
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text; v_business text; v_local timestamp; v_nome text; v_hora text;
  t text; m text[]; k text; v text;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return null; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  v_service := whatsapp_private.appointment_services_label(a.id);   -- [0033] todos os serviços
  select co.name into v_business from companies co where co.id = a.company_id;
  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_hora := extract(hour from v_local)::int::text || 'h'
            || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;
  v_nome := coalesce(nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], ''), '');

  t := replace(replace(p_template, E'\r\n', E'\n'), E'\r', E'\n');
  for m in select regexp_matches(t, '\{([^{}\s]{1,30})\}', 'g') loop
    k := whatsapp_private.normalize_variable(m[1]);
    v := case k
           when 'nome' then v_nome
           when 'negocio' then btrim(coalesce(v_business, ''))
           when 'servico' then btrim(coalesce(v_service, ''))
           when 'data' then to_char(v_local, 'DD/MM')
           when 'dia_semana' then wd[extract(dow from v_local)::int + 1]
           when 'horario' then v_hora
         end;
    if v is not null then t := replace(t, '{' || m[1] || '}', v); end if;
  end loop;
  t := regexp_replace(t, '[ \t]+([,.!?;:])', '\1', 'g');
  t := regexp_replace(t, '[ \t]{2,}', ' ', 'g');
  t := regexp_replace(t, '[ \t]+(\n|$)', '\1', 'g');
  return btrim(t, E' \t\n\r');
end;
$$;

create or replace function whatsapp_private.reminder_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text; v_local timestamp;
  v_wd text; v_ddmm text; v_dia text; v_hora text;
  v_nome text; v_sv text; v_oi text; v_oitb text;
  v_hash bigint := 0; v_seed text; v_variant int; i int;
  v_greet text; v_body text;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return null; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  v_service := whatsapp_private.appointment_services_label(a.id);   -- [0033] todos os serviços

  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_wd := wd[extract(dow from v_local)::int + 1];
  v_ddmm := to_char(v_local, 'DD/MM');
  v_dia := 'amanhã, ' || v_wd || ' (' || v_ddmm || ')';
  v_hora := 'às ' || extract(hour from v_local)::int::text || 'h'
            || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;

  v_nome := nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], '');
  v_sv := btrim(coalesce(v_service, ''));
  v_oi := case when v_nome is not null then 'Oi, ' || v_nome || '!' else 'Oi!' end;
  v_oitb := case when v_nome is not null then 'Oi, ' || v_nome || ', tudo bem?' else 'Oi, tudo bem?' end;

  v_seed := a.id::text;
  for i in 1 .. char_length(v_seed) loop
    v_hash := (v_hash * 31 + ascii(substr(v_seed, i, 1))) % 4294967296;
  end loop;
  v_variant := (v_hash % 6)::int;

  case v_variant
    when 0 then v_greet := v_oi;
      v_body := 'Passando para lembrar do seu horário ' || v_dia || ', ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. Te espero! 💕';
    when 1 then v_greet := v_oitb;
      v_body := 'Só lembrando do seu horário' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ' ' || v_dia || ', ' || v_hora || '. Até amanhã!';
    when 2 then v_greet := v_oi;
      v_body := 'Amanhã é dia de se cuidar! Seu horário' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ' está marcado para ' || v_wd || ' (' || v_ddmm || '), ' || v_hora || '. ✨';
    when 3 then v_greet := v_oi;
      v_body := 'Lembrete do seu agendamento' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ': ' || v_dia || ', ' || v_hora || '. Qualquer imprevisto, é só me avisar por aqui.';
    when 4 then v_greet := v_oitb;
      v_body := 'Amanhã tem horário marcado comigo: ' || v_wd || ' (' || v_ddmm || '), ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. Vou adorar te receber! 🌸';
    else v_greet := v_oi;
      v_body := 'Passando para lembrar que te espero ' || v_dia || ', ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. Se precisar remarcar, é só me chamar por aqui.';
  end case;

  return v_greet || E'\n\n' || v_body;
end;
$$;

create or replace function whatsapp_private.notice_parts(p_appointment_id uuid, p_now timestamptz default now())
returns table (nome text, sv text, em text, para text, hora text, seed bigint)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text; v_local timestamp; v_today date; v_day date; v_wd text; v_ddmm text;
  v_hash bigint := 0; v_seed text; i int;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  v_service := whatsapp_private.appointment_services_label(a.id);   -- [0033] todos os serviços
  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_day := v_local::date;
  v_today := (p_now at time zone 'America/Sao_Paulo')::date;
  v_wd := wd[extract(dow from v_local)::int + 1];
  v_ddmm := to_char(v_local, 'DD/MM');
  nome := nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], '');
  sv := btrim(coalesce(v_service, ''));
  if v_day = v_today then
    em := 'hoje, ' || v_wd || ' (' || v_ddmm || ')'; para := em;
  elsif v_day = v_today + 1 then
    em := 'amanhã, ' || v_wd || ' (' || v_ddmm || ')'; para := em;
  else
    em := 'no dia ' || v_ddmm || ' (' || v_wd || ')'; para := 'o dia ' || v_ddmm || ' (' || v_wd || ')';
  end if;
  hora := 'às ' || extract(hour from v_local)::int::text || 'h'
          || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;
  v_seed := a.id::text || ':' || floor(extract(epoch from a.scheduled_start))::bigint::text;
  for i in 1 .. char_length(v_seed) loop
    v_hash := (v_hash * 31 + ascii(substr(v_seed, i, 1))) % 4294967296;
  end loop;
  seed := v_hash;
  return next;
end;
$$;

-- 6. PRIVILÉGIOS ------------------------------------------------------------------------------
revoke all on function whatsapp_private.appointment_services_label(uuid) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function whatsapp_private.appointment_services_label(uuid) from %I', r);
      execute format('revoke all on function whatsapp_private.system_confirmation_text(uuid, timestamptz), whatsapp_private.custom_confirmation_text(uuid, text), whatsapp_private.reminder_text(uuid, timestamptz), whatsapp_private.notice_parts(uuid, timestamptz) from %I', r);
    end if;
  end loop;
end $$;
revoke all on function set_appointment_extra_services(uuid, jsonb),
  create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) from public, anon;
grant execute on function set_appointment_extra_services(uuid, jsonb),
  create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function set_appointment_extra_services(uuid, jsonb),
      create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
