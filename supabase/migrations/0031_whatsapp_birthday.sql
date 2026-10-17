-- ---------------------------------------------------------------------------
-- 0031 — WhatsApp: mensagem de ANIVERSÁRIO
--
-- Por empresa (whatsapp_private.message_templates), nasce DESLIGADA:
--   birthday_enabled  (false)   liga/desliga
--   birthday_mode     ('system')  'system' = 6 mensagens variadas do sistema;
--                                 'custom' = mensagem própria com {nome} {negocio}
--   birthday_template           texto da mensagem própria
--
-- Disparo: whatsapp_private.enqueue_birthday_messages(), chamado pela tarefa da
-- 0032 (9h00–11h45 de Brasília, a cada 15 min). Só age a partir das 9h; idempotente
-- (1 mensagem por cliente por ano: chave primária + chave 'birthday:<cliente>:<ano>').
-- Quem recebe (mesma regra da Central): mesma empresa, comm_status 'allowed'
-- (autorizou), celular válido, não arquivada, sem SAIR. 29/02 → 28/02 em ano comum.
-- WhatsApp sem sinal / limite de ritmo: tenta na rodada seguinte (nada registrado).
-- Cópia IDÊNTICA dos textos na tela: lib/hive/birthday-message.ts.
-- Não altera confirmação, lembrete, avisos, Central, fila nem worker.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'whatsapp_private' and c.relname = 'message_templates') then
    raise exception '0031 ABORTADA — nada foi alterado. Aplique antes a 0027.' using errcode = '55000';
  end if;
end $$;

-- 1. CONFIGURAÇÃO E REGISTRO -----------------------------------------------------------
alter table whatsapp_private.message_templates
  add column if not exists birthday_enabled boolean not null default false,
  add column if not exists birthday_mode text not null default 'system',
  add column if not exists birthday_template text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wa_tpl_birthday_mode') then
    alter table whatsapp_private.message_templates
      add constraint wa_tpl_birthday_mode check (birthday_mode in ('system', 'custom')),
      add constraint wa_tpl_birthday_len check (birthday_template is null or char_length(birthday_template) <= 2000);
  end if;
end $$;

create table if not exists whatsapp_private.birthday_messages (
  client_id  uuid not null references clients (id) on delete cascade,
  year       int not null,
  company_id uuid not null references companies (id) on delete cascade,
  status     text not null check (status in ('queued', 'skipped')),
  reason     text,
  outbox_id  uuid references whatsapp_private.outbox (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (client_id, year)
);
create index if not exists wa_birthday_company_idx on whatsapp_private.birthday_messages (company_id, year);
alter table whatsapp_private.birthday_messages enable row level security;


-- 2. TEXTOS -----------------------------------------------------------------------------
create or replace function whatsapp_private.birthday_template_problems(p_template text)
returns text[]
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  t text := btrim(replace(replace(coalesce(p_template, ''), E'\r\n', E'\n'), E'\r', E'\n'), E' \t\n\r');
  m text[]; unknown text[] := '{}'; problems text[] := '{}';
begin
  if t = '' then return array['Escreva a mensagem.']; end if;
  if char_length(t) > 1000 then problems := array_append(problems, 'A mensagem passou de 1000 caracteres.'); end if;
  for m in select regexp_matches(t, '\{([^{}\s]{1,30})\}', 'g') loop
    if whatsapp_private.normalize_variable(m[1]) not in ('nome', 'negocio')
       and not ('{' || m[1] || '}') = any (unknown) then
      unknown := array_append(unknown, '{' || m[1] || '}');
    end if;
  end loop;
  if cardinality(unknown) > 0 then
    problems := array_append(problems, 'Variável desconhecida: ' || array_to_string(unknown, ', ') || '.');
  end if;
  return problems;
end;
$$;

-- opção 1: 6 variações; variação por cliente + ano
create or replace function whatsapp_private.birthday_system_text(p_client_name text, p_client_id uuid, p_year int)
returns text
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  n text := coalesce(nullif((regexp_split_to_array(btrim(coalesce(p_client_name, '')), '\s+'))[1], ''), '');
  v_seed text := p_client_id::text || ':' || p_year::text;
  v_hash bigint := 0; i int;
begin
  for i in 1 .. char_length(v_seed) loop
    v_hash := (v_hash * 31 + ascii(substr(v_seed, i, 1))) % 4294967296;
  end loop;
  case (v_hash % 6)::int
    when 0 then return 'Feliz aniversário' || case when n <> '' then ', ' || n else '' end
                       || '! 🎉 Que seu novo ciclo venha cheio de alegria, saúde e muitos motivos para sorrir.';
    when 1 then return 'Oi' || case when n <> '' then ', ' || n else '' end
                       || '! Hoje o dia é seu: feliz aniversário! Desejo um ano lindo, com muito carinho e realizações. 💕';
    when 2 then return case when n <> '' then n || ', feliz' else 'Feliz' end
                       || ' aniversário! Que hoje seja especial do começo ao fim. Um abraço carinhoso!';
    when 3 then return 'Parabéns' || case when n <> '' then ', ' || n else '' end
                       || '! 🎂 Desejo que este novo ano traga tudo de bom para você.';
    when 4 then return 'Oi' || case when n <> '' then ', ' || n else '' end
                       || '! Passando para te desejar um feliz aniversário, com muita saúde, paz e momentos felizes. ✨';
    else return 'Feliz aniversário' || case when n <> '' then ', ' || n else '' end
                || '! Que a vida te presenteie com dias leves e muita alegria. Um beijo!';
  end case;
end;
$$;

-- opção 2: mensagem própria (mesma troca e limpeza da confirmação própria)
create or replace function whatsapp_private.birthday_custom_text(p_template text, p_client_name text, p_company_name text)
returns text
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  t text := replace(replace(p_template, E'\r\n', E'\n'), E'\r', E'\n');
  n text := coalesce(nullif((regexp_split_to_array(btrim(coalesce(p_client_name, '')), '\s+'))[1], ''), '');
  m text[]; k text; v text;
begin
  for m in select regexp_matches(t, '\{([^{}\s]{1,30})\}', 'g') loop
    k := whatsapp_private.normalize_variable(m[1]);
    v := case k when 'nome' then n when 'negocio' then btrim(coalesce(p_company_name, '')) end;
    if v is not null then t := replace(t, '{' || m[1] || '}', v); end if;
  end loop;
  t := regexp_replace(t, '[ \t]+([,.!?;:])', '\1', 'g');
  t := regexp_replace(t, '[ \t]{2,}', ' ', 'g');
  t := regexp_replace(t, '[ \t]+(\n|$)', '\1', 'g');
  return btrim(t, E' \t\n\r');
end;
$$;


-- 3. DISPARO (tarefa da 0032; idempotente) --------------------------------------------------
create or replace function whatsapp_private.enqueue_birthday_messages(p_now timestamptz default now())
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_local timestamp := p_now at time zone 'America/Sao_Paulo';
  v_today date := (p_now at time zone 'America/Sao_Paulo')::date;
  v_year int := extract(year from (p_now at time zone 'America/Sao_Paulo'))::int;
  v_leap boolean;
  r record; cl clients%rowtype; v_reason text; v_body text; rr jsonb;
  n_queued int := 0; n_skipped int := 0; n_retry int := 0;
begin
  if v_local::time < time '09:00' then return jsonb_build_object('status', 'too_early'); end if;
  v_leap := (v_year % 4 = 0 and v_year % 100 <> 0) or v_year % 400 = 0;

  for r in
    select c.id as client_id, c.company_id, c.name, co.name as company_name, t.birthday_mode, t.birthday_template
    from clients c
    join whatsapp_private.message_templates t on t.company_id = c.company_id and t.birthday_enabled
    join whatsapp_private.sessions s on s.company_id = c.company_id
    join companies co on co.id = c.company_id
    where c.birth_date is not null
      and (   (extract(month from c.birth_date) = extract(month from v_today) and extract(day from c.birth_date) = extract(day from v_today))
           or (not v_leap and extract(month from c.birth_date) = 2 and extract(day from c.birth_date) = 29
               and extract(month from v_today) = 2 and extract(day from v_today) = 28))
      and not exists (select 1 from whatsapp_private.birthday_messages b where b.client_id = c.id and b.year = v_year)
    order by c.company_id, c.name
  loop
    begin
      select * into cl from clients where id = r.client_id;
      v_reason := whatsapp_private.recipient_block(cl);
      if v_reason is null and cl.comm_status <> 'allowed' then v_reason := 'consent_unknown'; end if;
      if v_reason is not null then
        insert into whatsapp_private.birthday_messages (client_id, year, company_id, status, reason)
        values (r.client_id, v_year, r.company_id, 'skipped', v_reason) on conflict do nothing;
        n_skipped := n_skipped + 1;
        continue;
      end if;
      if not whatsapp_private.session_ready(r.company_id) then
        n_retry := n_retry + 1;          -- sem sinal: tenta na próxima rodada
        continue;
      end if;
      v_body := case when r.birthday_mode = 'custom' and r.birthday_template is not null
                          and cardinality(whatsapp_private.birthday_template_problems(r.birthday_template)) = 0
                     then whatsapp_private.birthday_custom_text(r.birthday_template, r.name, r.company_name)
                     else whatsapp_private.birthday_system_text(r.name, r.client_id, v_year) end;
      rr := whatsapp_private.enqueue_send(r.company_id, r.client_id, null, cl.phone_normalized, v_body,
                                          'birthday:' || r.client_id || ':' || v_year);
      insert into whatsapp_private.birthday_messages (client_id, year, company_id, status, outbox_id)
      values (r.client_id, v_year, r.company_id, 'queued', (rr ->> 'outbox_id')::uuid) on conflict do nothing;
      n_queued := n_queued + 1;
    exception when others then
      if sqlstate = 'AUW03' then
        n_retry := n_retry + 1;          -- limite de ritmo: próxima rodada
      else
        insert into whatsapp_private.birthday_messages (client_id, year, company_id, status, reason)
        values (r.client_id, v_year, r.company_id, 'skipped', 'error') on conflict do nothing;
        n_skipped := n_skipped + 1;
        raise warning 'aniversário não enfileirado (%)', sqlstate;   -- sem dados pessoais
      end if;
    end;
  end loop;
  return jsonb_build_object('status', 'ok', 'queued', n_queued, 'skipped', n_skipped, 'retry_later', n_retry);
end;
$$;


-- 4. RPCs DO APP (ler: qualquer membro; mudar: owner/admin) -----------------------------------
create or replace function wa_get_birthday_settings(p_company_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_role member_role;
  t whatsapp_private.message_templates%rowtype;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  v_role := whatsapp_private.caller_role(p_company_id);
  if v_role is null then raise exception 'Empresa não encontrada.' using errcode = 'P0002'; end if;
  select * into t from whatsapp_private.message_templates where company_id = p_company_id;
  return jsonb_build_object(
    'enabled', coalesce(t.birthday_enabled, false),
    'mode', coalesce(t.birthday_mode, 'system'),
    'template', t.birthday_template,
    'can_manage', v_role in ('owner', 'admin'));
end;
$$;

create or replace function wa_set_birthday_settings(p_company_id uuid, p_enabled boolean, p_mode text, p_template text)
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
    raise exception 'Só a administração da empresa muda a mensagem de aniversário.' using errcode = '42501';
  end if;
  if p_enabled is null or p_mode is null or p_mode not in ('system', 'custom') then
    raise exception 'Escolha uma opção válida.' using errcode = '22023';
  end if;
  if p_mode = 'custom' then
    v_problems := whatsapp_private.birthday_template_problems(v_template);
    if cardinality(v_problems) > 0 then
      raise exception '%', array_to_string(v_problems, ' ') using errcode = 'AUT01';
    end if;
  end if;
  insert into whatsapp_private.message_templates (company_id, birthday_enabled, birthday_mode, birthday_template, updated_by, updated_at)
  values (p_company_id, p_enabled, p_mode, v_template, auth.uid(), now())
  on conflict (company_id) do update
    set birthday_enabled = excluded.birthday_enabled,
        birthday_mode = excluded.birthday_mode,
        birthday_template = coalesce(v_template, whatsapp_private.message_templates.birthday_template),
        updated_by = excluded.updated_by, updated_at = now();
  return wa_get_birthday_settings(p_company_id);
end;
$$;


-- 5. PRIVILÉGIOS --------------------------------------------------------------------------------
revoke all on whatsapp_private.birthday_messages from public;
revoke all on function whatsapp_private.birthday_template_problems(text), whatsapp_private.birthday_system_text(text, uuid, int),
  whatsapp_private.birthday_custom_text(text, text, text), whatsapp_private.enqueue_birthday_messages(timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on whatsapp_private.birthday_messages from %I', r);
      execute format('revoke all on function whatsapp_private.birthday_template_problems(text), whatsapp_private.birthday_system_text(text, uuid, int), whatsapp_private.birthday_custom_text(text, text, text), whatsapp_private.enqueue_birthday_messages(timestamptz) from %I', r);
    end if;
  end loop;
end $$;
revoke all on function wa_get_birthday_settings(uuid), wa_set_birthday_settings(uuid, boolean, text, text) from public, anon;
grant execute on function wa_get_birthday_settings(uuid), wa_set_birthday_settings(uuid, boolean, text, text) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function wa_get_birthday_settings(uuid), wa_set_birthday_settings(uuid, boolean, text, text) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
