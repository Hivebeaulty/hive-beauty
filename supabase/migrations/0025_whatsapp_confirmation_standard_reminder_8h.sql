-- ---------------------------------------------------------------------------
-- 0025 — WhatsApp: confirmação em FORMATO PADRÃO + lembrete às 8h da véspera
--
-- 1. confirmation_text: um único modelo, igual para todas as clientes (sem
--    variações), com cópia IDÊNTICA na tela (lib/hive/appointment-message.ts):
--
--      Olá, Ana!
--
--      Horário agendado: quinta-feira, 16/10, às 14h
--      Serviço: Manicure
--
--      Para remarcações, o prazo mínimo é de 24h.
--
--      Obrigada!
--
-- 2. enqueue_day_before_reminders: o lembrete da véspera passa de 18h para 8h
--    (horário de Brasília). A regra "agendado DEPOIS do disparo da véspera →
--    pula" acompanha: o corte vira 8h. O agendamento da tarefa (pg_cron) muda na
--    0026. O texto do lembrete NÃO muda ("amanhã" continua certo às 8h da véspera).
--
-- Mesmos nomes, parâmetros e retornos: gatilhos, fila, chaves e permissões
-- continuam iguais.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_day_before_reminders') then
    raise exception '0025 ABORTADA — nada foi alterado. Aplique antes a 0020.' using errcode = '55000';
  end if;
end $$;

-- 1. CONFIRMAÇÃO — formato padrão
create or replace function whatsapp_private.confirmation_text(p_appointment_id uuid, p_now timestamptz default now())
returns text
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  v_client text; v_service text; v_local timestamp; v_nome text; v_sv text; v_hora text;
  wd constant text[] := array['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
begin
  select * into a from appointments where id = p_appointment_id;
  if not found then return null; end if;
  select c.name into v_client from clients c where c.id = a.client_id and c.company_id = a.company_id;
  select s.name into v_service from services s where s.id = a.service_id;

  v_local := a.scheduled_start at time zone 'America/Sao_Paulo';
  v_hora := extract(hour from v_local)::int::text || 'h'
            || case when extract(minute from v_local)::int = 0 then '' else lpad(extract(minute from v_local)::int::text, 2, '0') end;
  v_nome := nullif((regexp_split_to_array(btrim(coalesce(v_client, '')), '\s+'))[1], '');
  v_sv := btrim(coalesce(v_service, ''));

  return case when v_nome is not null then 'Olá, ' || v_nome || '!' else 'Olá!' end
      || E'\n\n' || 'Horário agendado: ' || wd[extract(dow from v_local)::int + 1] || ', ' || to_char(v_local, 'DD/MM') || ', às ' || v_hora
      || case when v_sv <> '' then E'\nServiço: ' || v_sv else '' end
      || E'\n\nPara remarcações, o prazo mínimo é de 24h.\n\nObrigada!';
end;
$$;

-- 2. LEMBRETE — disparo e corte às 8h da véspera
create or replace function whatsapp_private.enqueue_day_before_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_local timestamp := p_now at time zone 'America/Sao_Paulo';
  v_today date := (p_now at time zone 'America/Sao_Paulo')::date;
  v_cutoff timestamptz := ((p_now at time zone 'America/Sao_Paulo')::date + time '08:00') at time zone 'America/Sao_Paulo';
  r record;
  c clients%rowtype;
  v_reason text;
  rr jsonb;
  n_queued int := 0; n_skipped int := 0; n_retry int := 0;
begin
  if not coalesce((select reminder_enabled from whatsapp_private.settings where id), false) then
    return jsonb_build_object('status', 'disabled');
  end if;
  if v_local::time < time '08:00' then
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

-- privilégios: create or replace preserva os anteriores; reforça que ninguém de fora executa
revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz),
  whatsapp_private.enqueue_day_before_reminders(timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function whatsapp_private.confirmation_text(uuid, timestamptz), whatsapp_private.enqueue_day_before_reminders(timestamptz) from %I', r);
    end if;
  end loop;
end $$;
