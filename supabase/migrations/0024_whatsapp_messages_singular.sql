-- ---------------------------------------------------------------------------
-- 0024 — WhatsApp: mensagens automáticas na PRIMEIRA PESSOA DO SINGULAR
--
-- Quem fala é a profissional ("te espero", "me avise", "comigo"), não uma
-- equipe ("te esperamos", "a gente", "estamos por aqui").
--
-- Substitui SOMENTE os textos (mesmos nomes, parâmetros e retornos):
--   confirmation_text      (0019)  confirmação de agendamento
--   reminder_text          (0020)  lembrete da véspera
--   reschedule_notice_text (0023)  aviso de ALTERAÇÃO: agora neutro entre
--                                  horário e serviço ("seu agendamento foi
--                                  atualizado"), sempre com serviço, dia e hora
--                                  novos — antes dizia "horário" mesmo quando
--                                  só o serviço mudava
--   cancel_notice_text     (0023)  aviso de cancelamento
-- Mesmas variações, mesma escolha determinística, mesmos dados dinâmicos e o
-- mesmo uso ocasional de emoji. Não altera gatilhos, fila, horários de envio,
-- chaves de idempotência, tabelas nem permissões.
-- A confirmação continua com cópia IDÊNTICA na tela (lib/hive/appointment-message.ts):
-- teste de paridade em supabase/tests/local/0018_message_parity.cjs.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'whatsapp_private' and p.proname = 'cancel_notice_text') then
    raise exception '0024 ABORTADA — nada foi alterado. Aplique antes a 0023.' using errcode = '55000';
  end if;
end $$;

-- 1. CONFIRMAÇÃO
create or replace function whatsapp_private.confirmation_text(p_appointment_id uuid, p_now timestamptz default now())
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

-- 2. LEMBRETE DA VÉSPERA
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

-- 3. ALTERAÇÃO (horário e/ou serviço)
create or replace function whatsapp_private.reschedule_notice_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  p record; v_oi text; v_oitb text; v_greet text; v_body text;
begin
  select * into p from whatsapp_private.notice_parts(p_appointment_id, p_now);
  if not found then return null; end if;
  v_oi := case when p.nome is not null then 'Oi, ' || p.nome || '!' else 'Oi!' end;
  v_oitb := case when p.nome is not null then 'Oi, ' || p.nome || ', tudo bem?' else 'Oi, tudo bem?' end;
  case (p.seed % 6)::int
    when 0 then v_greet := v_oi;
      v_body := 'Seu agendamento foi atualizado! Agora te espero ' || p.em || ', ' || p.hora
                || case when p.sv <> '' then ', para ' || p.sv else '' end || '. 💕';
    when 1 then v_greet := v_oitb;
      v_body := 'Passando para avisar que seu agendamento mudou. Agora ele fica ' || p.em || ', ' || p.hora
                || case when p.sv <> '' then ', para ' || p.sv else '' end || '. Qualquer dúvida, é só me chamar por aqui.';
    when 2 then v_greet := v_oi;
      v_body := 'Seu agendamento foi atualizado para ' || p.para || ', ' || p.hora
                || case when p.sv <> '' then ', para ' || p.sv else '' end || '. Te espero! ✨';
    when 3 then v_greet := v_oi;
      v_body := 'Tudo certo com a mudança: seu agendamento' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' agora é ' || p.em || ', ' || p.hora || '. Até lá!';
    when 4 then v_greet := v_oitb;
      v_body := 'Atualizei o seu agendamento' || case when p.sv <> '' then ': ' || p.sv || ' ' || p.em else ' para ' || p.para end
                || ', ' || p.hora || '. Se precisar de outro horário, é só me avisar por aqui. 🌸';
    else v_greet := v_oi;
      v_body := 'Só para avisar: seu agendamento' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' ficou para ' || p.para || ', ' || p.hora || '. Qualquer imprevisto, é só me chamar por aqui.';
  end case;
  return v_greet || E'\n\n' || v_body;
end;
$$;

-- 4. CANCELAMENTO
create or replace function whatsapp_private.cancel_notice_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  p record; v_oi text; v_oitb text; v_greet text; v_body text;
begin
  select * into p from whatsapp_private.notice_parts(p_appointment_id, p_now);
  if not found then return null; end if;
  v_oi := case when p.nome is not null then 'Oi, ' || p.nome || '!' else 'Oi!' end;
  v_oitb := case when p.nome is not null then 'Oi, ' || p.nome || ', tudo bem?' else 'Oi, tudo bem?' end;
  case (p.seed % 4)::int
    when 0 then v_greet := v_oi;
      v_body := 'Passando para avisar que seu agendamento' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' ' || p.em || ', ' || p.hora || ', foi cancelado. Se quiser marcar um novo horário, é só me chamar por aqui.';
    when 1 then v_greet := v_oitb;
      v_body := 'Seu horário' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' ' || p.em || ', ' || p.hora || ', foi cancelado. Quando quiser remarcar, estou por aqui. 💕';
    when 2 then v_greet := v_oi;
      v_body := 'Só para avisar: o seu agendamento ' || p.em || ', ' || p.hora
                || case when p.sv <> '' then ', para ' || p.sv else '' end
                || ', foi cancelado. Se precisar, é só me chamar por aqui para marcar outro horário.';
    else v_greet := v_oi;
      v_body := 'Seu agendamento' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' ' || p.em || ', ' || p.hora || ', foi cancelado. Qualquer coisa, é só falar comigo por aqui.';
  end case;
  return v_greet || E'\n\n' || v_body;
end;
$$;

-- privilégios: create or replace preserva os anteriores; reforça que ninguém de fora executa
revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz), whatsapp_private.reminder_text(uuid, timestamptz),
  whatsapp_private.reschedule_notice_text(uuid, timestamptz), whatsapp_private.cancel_notice_text(uuid, timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz), whatsapp_private.reminder_text(uuid, timestamptz), whatsapp_private.reschedule_notice_text(uuid, timestamptz), whatsapp_private.cancel_notice_text(uuid, timestamptz) from %I', r);
    end if;
  end loop;
end $$;
