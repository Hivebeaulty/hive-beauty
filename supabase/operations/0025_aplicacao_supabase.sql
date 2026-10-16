-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0025 + 0026 (confirmação padrão; lembrete às 8h) — ROTEIRO
--
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Pré-requisito: 0024 aplicada; pg_cron ativo.
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: f | */15 21-23 * * * | 1
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text'
                 and p.prosrc like '%prazo mínimo é de 24h%') as ja_tem_formato_padrao,
       (select schedule from cron.job where jobname = 'aurea-wa-day-before-reminder') as agenda_lembrete_utc,
       (select count(*) from cron.job where jobname = 'aurea-wa-day-before-reminder') as jobs_lembrete;
-- [/B0]

-- [B2] APLICAR: 0025_whatsapp_confirmation_standard_reminder_8h.sql e depois 0026_schedule_reminder_8h.sql.

-- [B3] DEPOIS (só leitura). Esperado: t | */15 11-13 * * * | 1 | 13 | 0
select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text'
                 and p.prosrc like '%prazo mínimo é de 24h%') as formato_padrao,
       (select schedule from cron.job where jobname = 'aurea-wa-day-before-reminder') as agenda_lembrete_utc,
       (select count(*) from cron.job where jobname = 'aurea-wa-day-before-reminder') as jobs_lembrete,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas;
-- [/B3]

-- [B4] TRANSIÇÃO (rodar UMA vez logo depois de aplicar, se for depois das 8h):
--      o disparo das 18h de hoje deixa de existir; sem isto, os atendimentos de
--      AMANHÃ ficariam sem lembrete. Idempotente (não duplica).
select whatsapp_private.enqueue_day_before_reminders();
-- [/B4]

-- [BR] REVERSÃO da 0025 + 0026 (volta exatamente ao estado da 0024: confirmação
--      com variações e lembrete às 18h).
-- [BR-SQL]
begin;
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

create or replace function whatsapp_private.enqueue_day_before_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_local timestamp := p_now at time zone 'America/Sao_Paulo';
  v_today date := (p_now at time zone 'America/Sao_Paulo')::date;
  v_cutoff timestamptz := ((p_now at time zone 'America/Sao_Paulo')::date + time '18:00') at time zone 'America/Sao_Paulo';
  r record;
  c clients%rowtype;
  v_reason text;
  rr jsonb;
  n_queued int := 0; n_skipped int := 0; n_retry int := 0;
begin
  if not coalesce((select reminder_enabled from whatsapp_private.settings where id), false) then
    return jsonb_build_object('status', 'disabled');
  end if;
  if v_local::time < time '18:00' then
    return jsonb_build_object('status', 'too_early');
  end if;

  for r in
    select a.id, a.company_id, a.client_id, a.created_at, s.reminder as pref
    from appointments a
    join whatsapp_private.sessions s on s.company_id = a.company_id
    where (a.scheduled_start at time zone 'America/Sao_Paulo')::date = v_today + 1
      and a.status in ('agendado', 'confirmado')
      and a.scheduled_start > p_now
      and not exists (select 1 from whatsapp_private.appointment_reminders ar where ar.appointment_id = a.id)
    order by a.company_id, a.scheduled_start
  loop
    begin
      v_reason := null;
      if not r.pref then
        v_reason := 'disabled';
      elsif r.created_at >= v_cutoff then
        v_reason := 'late_booking';
      else
        select * into c from clients where id = r.client_id and company_id = r.company_id;
        v_reason := case when not found then 'no_client' else whatsapp_private.recipient_block(c) end;
      end if;

      if v_reason is not null then
        insert into whatsapp_private.appointment_reminders (appointment_id, company_id, status, reason, remind_date)
        values (r.id, r.company_id, 'skipped', v_reason, v_today) on conflict (appointment_id) do nothing;
        n_skipped := n_skipped + 1;
        continue;
      end if;

      if not whatsapp_private.session_ready(r.company_id) then
        n_retry := n_retry + 1;          -- sem sinal: tenta na próxima rodada, nada registrado
        continue;
      end if;

      rr := whatsapp_private.enqueue_send(r.company_id, c.id, r.id, c.phone_normalized,
                                          whatsapp_private.reminder_text(r.id, p_now), 'reminder:' || r.id);
      insert into whatsapp_private.appointment_reminders (appointment_id, company_id, status, outbox_id, remind_date)
      values (r.id, r.company_id, 'queued', (rr ->> 'outbox_id')::uuid, v_today) on conflict (appointment_id) do nothing;
      n_queued := n_queued + 1;
    exception when others then
      if sqlstate = 'AUW03' then
        n_retry := n_retry + 1;          -- limite de ritmo: continua na próxima rodada
      else
        insert into whatsapp_private.appointment_reminders (appointment_id, company_id, status, reason, remind_date)
        values (r.id, r.company_id, 'skipped', 'error', v_today) on conflict (appointment_id) do nothing;
        n_skipped := n_skipped + 1;
        raise warning 'lembrete não enfileirado (%)', sqlstate;   -- sem dados pessoais
      end if;
    end;
  end loop;

  return jsonb_build_object('status', 'ok', 'queued', n_queued, 'skipped', n_skipped, 'retry_later', n_retry);
end;
$$;
revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz),
  whatsapp_private.enqueue_day_before_reminders(timestamptz) from public;
select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-day-before-reminder';
select cron.schedule('aurea-wa-day-before-reminder', '*/15 21-23 * * *', $job$select whatsapp_private.enqueue_day_before_reminders()$job$);
commit;
-- [/BR-SQL]
