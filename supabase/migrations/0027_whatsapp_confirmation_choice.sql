-- ---------------------------------------------------------------------------
-- 0027 — Confirmação: a EMPRESA escolhe o formato
--
--   opção 1 'system' (PADRÃO de todas): as 8 mensagens variadas do sistema,
--            no singular (texto exato da 0024 — volta a valer; desfaz o formato
--            padrão único da 0025).
--   opção 2 'custom': mensagem própria da profissional, com variáveis
--            {nome} {negocio} {servico} {data} {dia_semana} {horario}.
--
-- confirmation_text continua com o MESMO nome/parâmetros (gatilho e fila não
-- mudam): só escolhe entre system_confirmation_text e custom_confirmation_text.
-- Mensagem própria inválida nunca é enviada: cai na opção 1.
-- Cópia IDÊNTICA na tela (lib/hive/message-template.ts e appointment-message.ts):
-- paridade em supabase/tests/local/0018_message_parity.cjs.
-- O lembrete às 8h (0025/0026) não muda.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_day_before_reminders') then
    raise exception '0027 ABORTADA — nada foi alterado. Aplique antes a 0020.' using errcode = '55000';
  end if;
end $$;

-- 1. ESCOLHA POR EMPRESA ------------------------------------------------------------
create table if not exists whatsapp_private.message_templates (
  company_id            uuid primary key references companies (id) on delete cascade,
  confirmation_mode     text not null default 'system' check (confirmation_mode in ('system', 'custom')),
  confirmation_template text check (confirmation_template is null or char_length(confirmation_template) <= 2000),
  updated_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now()
);
alter table whatsapp_private.message_templates enable row level security;


-- 2. OPÇÃO 1: mensagens variadas do sistema (texto exato da 0024) ---------------------
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


-- 3. OPÇÃO 2: mensagem própria ---------------------------------------------------------
-- {Serviço} → servico ; {HORÁRIO} → horario
create or replace function whatsapp_private.normalize_variable(p_raw text)
returns text
language sql immutable
set search_path = public, pg_temp
as $$
  select lower(translate(p_raw, 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
                                'aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc'))
$$;

-- Problemas que impedem usar a mensagem (vazio = pode). Mesmas frases da tela.
create or replace function whatsapp_private.template_problems(p_template text)
returns text[]
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  t text := btrim(replace(replace(coalesce(p_template, ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n\r');
  m text[]; k text; unknown text[] := '{}'; used text[] := '{}'; problems text[] := '{}';
begin
  if t = '' then return array['Escreva a mensagem.']; end if;
  if char_length(t) > 1000 then problems := array_append(problems, 'A mensagem passou de 1000 caracteres.'); end if;
  for m in select regexp_matches(t, '\{([^{}\s]{1,30})\}', 'g') loop
    k := whatsapp_private.normalize_variable(m[1]);
    if k in ('nome', 'negocio', 'servico', 'data', 'dia_semana', 'horario') then
      if not k = any (used) then used := array_append(used, k); end if;
    elsif not ('{' || m[1] || '}') = any (unknown) then
      unknown := array_append(unknown, '{' || m[1] || '}');
    end if;
  end loop;
  if cardinality(unknown) > 0 then
    problems := array_append(problems, 'Variável desconhecida: ' || array_to_string(unknown, ', ') || '.');
  end if;
  if not ('data' = any (used) and 'horario' = any (used)) then
    problems := array_append(problems, 'Inclua {data} e {horario} na mensagem.');
  end if;
  return problems;
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


-- 4. ESCOLHA: confirmation_text (mesmo nome usado pelo gatilho e pela fila) -------------
create or replace function whatsapp_private.confirmation_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  mt whatsapp_private.message_templates%rowtype;
begin
  select t.* into mt from whatsapp_private.message_templates t
  join appointments a on a.company_id = t.company_id where a.id = p_appointment_id;
  if found and mt.confirmation_mode = 'custom' and mt.confirmation_template is not null
     and cardinality(whatsapp_private.template_problems(mt.confirmation_template)) = 0 then
    return whatsapp_private.custom_confirmation_text(p_appointment_id, mt.confirmation_template);
  end if;
  return whatsapp_private.system_confirmation_text(p_appointment_id, p_now);
end;
$$;


-- 5. RPCs DO APP ------------------------------------------------------------------------
-- Qualquer membro lê (a tela de agendamento usa no envio manual); só owner/admin muda.
create or replace function wa_get_message_settings(p_company_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  mt whatsapp_private.message_templates%rowtype;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  select * into mt from whatsapp_private.message_templates where company_id = p_company_id;
  return jsonb_build_object(
    'mode', coalesce(mt.confirmation_mode, 'system'),
    'template', mt.confirmation_template,
    'can_manage', v_role in ('owner', 'admin'));
end;
$$;

create or replace function wa_set_message_settings(p_company_id uuid, p_mode text, p_template text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  v_problems text[];
  v_template text := nullif(btrim(replace(replace(coalesce(p_template, ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n\r'), '');
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Só a administração da empresa muda a mensagem de confirmação.' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('system', 'custom') then
    raise exception 'Escolha uma opção válida.' using errcode = '22023';
  end if;
  if p_mode = 'custom' then
    v_problems := whatsapp_private.template_problems(v_template);
    if cardinality(v_problems) > 0 then
      raise exception '%', array_to_string(v_problems, ' ') using errcode = 'AUT01';
    end if;
  end if;
  insert into whatsapp_private.message_templates (company_id, confirmation_mode, confirmation_template, updated_by, updated_at)
  values (p_company_id, p_mode, coalesce(v_template, (select confirmation_template from whatsapp_private.message_templates where company_id = p_company_id)), auth.uid(), now())
  on conflict (company_id) do update
    set confirmation_mode = excluded.confirmation_mode,
        confirmation_template = coalesce(v_template, whatsapp_private.message_templates.confirmation_template),
        updated_by = excluded.updated_by, updated_at = now();
  return wa_get_message_settings(p_company_id);
end;
$$;


-- 6. PRIVILÉGIOS ---------------------------------------------------------------------------
revoke all on whatsapp_private.message_templates from public;
revoke all on function whatsapp_private.system_confirmation_text(uuid, timestamptz), whatsapp_private.normalize_variable(text),
  whatsapp_private.template_problems(text), whatsapp_private.custom_confirmation_text(uuid, text),
  whatsapp_private.confirmation_text(uuid, timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on whatsapp_private.message_templates from %I', r);
      execute format('revoke all on function whatsapp_private.system_confirmation_text(uuid, timestamptz), whatsapp_private.normalize_variable(text), whatsapp_private.template_problems(text), whatsapp_private.custom_confirmation_text(uuid, text), whatsapp_private.confirmation_text(uuid, timestamptz) from %I', r);
    end if;
  end loop;
end $$;
revoke all on function wa_get_message_settings(uuid), wa_set_message_settings(uuid, text, text) from public, anon;
grant execute on function wa_get_message_settings(uuid), wa_set_message_settings(uuid, text, text) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function wa_get_message_settings(uuid), wa_set_message_settings(uuid, text, text) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
