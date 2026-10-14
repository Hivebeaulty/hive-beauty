-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0019 (texto da confirmação: sem assinatura, 8 variações)
--
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Pré-requisito: 0018 aplicada.
-- A 0019 troca SOMENTE a função whatsapp_private.confirmation_text. Não altera
-- tabelas, dados, gatilhos, fila nem permissões. Vale para confirmações criadas
-- a partir da aplicação e também para as que ainda estiverem pendentes na fila
-- (o texto é refeito na hora do envio). Mensagens já enviadas não mudam.
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text') as tem_0018,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text'
                 and p.prosrc like '%v_hash \% 8%') as ja_tem_0019;
-- [/B0]

-- [B2] APLICAR: arquivo 0019_whatsapp_message_variants.sql inteiro (transação única).

-- [B3] DEPOIS (só leitura). Esperado: t | 0 | 13 | 0
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text'
                 and p.prosrc like '%v_hash \% 8%') as tem_0019,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon','authenticated','service_role','wa_worker']) rl
         where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text'
           and has_function_privilege(rl, p.oid, 'execute')) as quem_de_fora_executa_o_texto,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from whatsapp_private.outbox where status in ('pending','processing')) as fila_pendente;
-- [/B3]

-- [BR] REVERSÃO: volta EXATAMENTE ao texto da 0018 (cópia literal abaixo).
-- [BR-SQL]
begin;
create or replace function whatsapp_private.confirmation_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text; v_business text; v_display text; v_full text;
  v_local timestamp; v_today date; v_day date;
  v_wd text; v_ddmm text; v_daylabel text; v_time text; v_when text;
  v_nome text; v_minutes int; v_h int; v_m int; v_dur text; v_line text;
  v_p text; v_sign text;
  v_hash bigint := 0; v_seed text; v_variant int; i int;
  v_greet text; v_intro text; v_close text;
  arr text[]; outl text[] := '{}'; v_txt text;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return null; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  select s.name into v_service from services s where s.id = a.service_id;
  select co.name into v_business from companies co where co.id = a.company_id;
  select nullif(btrim(p.display_name), ''), p.full_name into v_display, v_full
  from company_members cm join profiles p on p.id = cm.user_id
  where cm.id = a.professional_member_id and cm.company_id = a.company_id;

  -- quando: "hoje, terça-feira (15/10)" | "amanhã, quarta-feira (16/10)" | "quinta-feira, 17/10", "às 14h30"
  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_day := v_local::date;
  v_today := (p_now at time zone 'America/Sao_Paulo')::date;
  v_wd := wd[extract(dow from v_local)::int + 1];
  v_ddmm := to_char(v_local, 'DD/MM');
  v_daylabel := case when v_day = v_today then 'hoje, ' || v_wd || ' (' || v_ddmm || ')'
                     when v_day = v_today + 1 then 'amanhã, ' || v_wd || ' (' || v_ddmm || ')'
                     else v_wd || ', ' || v_ddmm end;
  v_time := extract(hour from v_local)::int::text || 'h'
            || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;
  v_when := v_daylabel || ', às ' || v_time;

  -- 1º nome da cliente
  v_nome := nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], '');

  -- "Serviço · 1h30" (formatDuration: 45min | 1h | 1h30 | 1h5)
  v_minutes := floor(extract(epoch from (a.scheduled_end - a.scheduled_start)) / 60)::int;
  if v_minutes > 0 then
    v_h := v_minutes / 60; v_m := v_minutes % 60;
    v_dur := case when v_h = 0 then v_m || 'min' when v_m = 0 then v_h || 'h' else v_h || 'h' || v_m end;
  end if;
  v_line := array_to_string(array_remove(array[nullif(btrim(coalesce(v_service, '')), ''), v_dur], null), ' · ');

  -- assinatura: resolveSignatureName + signature()
  v_p := btrim(left(btrim(regexp_replace(coalesce(v_display, ''), '\s+', ' ', 'g')), 40));
  if v_p = '' then v_p := coalesce((regexp_split_to_array(btrim(coalesce(v_full, '')), '\s+'))[1], ''); end if;
  v_business := btrim(coalesce(v_business, ''));
  v_sign := case when v_p <> '' and v_business <> '' and lower(v_p) <> lower(v_business) then v_p || ' · ' || v_business
                 when v_p <> '' then v_p else v_business end;

  -- variação determinística: hash(id) % 3, igual ao JS ((h*31 + code) >>> 0)
  v_seed := a.id::text;
  for i in 1 .. char_length(v_seed) loop
    v_hash := (v_hash * 31 + ascii(substr(v_seed, i, 1))) % 4294967296;
  end loop;
  v_variant := (v_hash % 3)::int;

  v_greet := case v_variant
    when 0 then case when v_nome is not null then 'Oi, ' || v_nome || '! 💛' else 'Oi! 💛' end
    when 1 then case when v_nome is not null then 'Oi, ' || v_nome || ', tudo bem?' else 'Oi, tudo bem?' end
    else case when v_nome is not null then 'Oi, ' || v_nome || '!' else 'Oi!' end end;
  v_intro := case v_variant
    when 0 then 'Seu horário está confirmado: ' || v_when || '.'
    when 1 then 'Passando para confirmar o seu horário: ' || v_when || '.'
    else 'Seu atendimento está marcado para ' || v_when || '.' end;
  v_close := case v_variant
    when 0 then 'Qualquer imprevisto, é só me avisar por aqui. Te espero!'
    when 1 then 'Se precisar remarcar, me avisa por aqui, combinado?'
    else 'Vai ser um prazer te receber! Se algo mudar, é só me chamar por aqui.' end;

  -- mesmas regras de linhas vazias do JS (filtro olha o array ORIGINAL)
  arr := array[v_greet, '', v_intro, v_line, '', v_close, v_sign];
  for i in 1 .. array_length(arr, 1) loop
    if not (arr[i] = '' and (i = 1 or arr[i - 1] = '')) then outl := outl || arr[i]; end if;
  end loop;
  v_txt := regexp_replace(array_to_string(outl, E'\n'), E'\n{3,}', E'\n\n', 'g');
  return btrim(v_txt, E' \n\t\r');
end;
$$;
revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz) from public;
commit;
-- [/BR-SQL]
