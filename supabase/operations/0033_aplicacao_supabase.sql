-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0033 (vários serviços no mesmo atendimento) — ROTEIRO
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Não altera dados nem envia nada; sem adicionais,
-- todas as mensagens continuam idênticas.
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f
select exists (select 1 from pg_proc where proname = 'edit_concluded_appointment') as tem_0030,
       exists (select 1 from pg_class where relname = 'appointment_extra_services') as tem_0033;
-- [/B0]

-- [B2] APLICAR: 0033_appointment_extra_services.sql (transação única).

-- [B3] DEPOIS (só leitura). Esperado: t | 4 | 0 | 13 | 0
select exists (select 1 from pg_class where relname = 'appointment_extra_services') as tem_0033,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private'
          and p.proname in ('system_confirmation_text','custom_confirmation_text','reminder_text','notice_parts')
          and p.prosrc like '%appointment_services_label%') as textos_com_lista,
       (select count(*) from pg_proc p cross join unnest(array['anon','service_role']) rl
         where p.proname in ('set_appointment_extra_services','create_appointment_with_extras') and has_function_privilege(rl, p.oid, 'execute')) as expostas_fora_do_app,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas;
-- [/B3]

-- [BR] REVERSÃO: volta EXATAMENTE às funções de texto anteriores e remove o resto.
--      ATENÇÃO: apaga a lista de serviços adicionais já lançados (o valor total dos
--      atendimentos e os recebimentos ficam como estão).
-- [BR-SQL]
begin;
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
  select s.name into v_service from services s where s.id = a.service_id;

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
  select s.name into v_service from services s where s.id = a.service_id;
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
  select s.name into v_service from services s where s.id = a.service_id;

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
  select s.name into v_service from services s where s.id = a.service_id;
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
drop function if exists public.create_appointment_with_extras(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb);
drop function if exists public.set_appointment_extra_services(uuid, jsonb);
drop function if exists whatsapp_private.appointment_services_label(uuid);
drop table if exists public.appointment_extra_services;
notify pgrst, 'reload schema';
commit;
-- [/BR-SQL]
