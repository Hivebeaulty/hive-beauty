-- ---------------------------------------------------------------------------
-- 0020 — WhatsApp: LEMBRETE na véspera do atendimento, às 18h (São Paulo)
--
-- Nasce DESLIGADO (whatsapp_private.settings.reminder_enabled = false). Quem
-- dispara é a tarefa agendada da 0021 (pg_cron), que chama
-- whatsapp_private.enqueue_day_before_reminders() a cada 15 min entre 18h00 e
-- 20h45 de Brasília; a função não faz nada antes das 18h e é idempotente.
--
-- Regras (aprovadas):
--   * 1 lembrete por agendamento, no máximo (chave primária + chave de
--     idempotência 'reminder:<id>' na fila).
--   * Atendimentos de AMANHÃ (data de São Paulo), ainda em aberto e no futuro.
--     Domingo/feriado não tem exceção: o lembrete sai na véspera, às 18h.
--   * Agendado DEPOIS das 18h da véspera → pula ('late_booking'): a cliente
--     acabou de receber a confirmação.
--   * Data/horário/serviço ATUAIS, lidos na hora do disparo; cancelado não recebe.
--   * Mesmas regras de destinatária da confirmação: celular válido, não
--     arquivada, não bloqueada (inclui SAIR); isolamento por empresa.
--   * WhatsApp sem sinal ou limite de ritmo: não registra nada e tenta de novo
--     na rodada seguinte (até 20h45). Motivos definitivos ficam registrados.
--   * Na fila (claim_outbox): se não sair na mesma noite, ou se o atendimento
--     deixou de ser "amanhã", o lembrete é cancelado.
--   * Preferência por empresa: whatsapp_private.sessions.reminder (padrão true).
--
-- Não altera dados existentes, a agenda, pagamentos nem a confirmação da 0018/0019.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text')
     or not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'whatsapp_private' and c.relname = 'appointment_confirmations') then
    raise exception '0020 ABORTADA — nada foi alterado. Aplique antes a 0018.' using errcode = '55000';
  end if;
end $$;

-- 1. CONFIGURAÇÃO -----------------------------------------------------------------
alter table whatsapp_private.settings
  add column if not exists reminder_enabled boolean not null default false;
alter table whatsapp_private.sessions
  add column if not exists reminder boolean not null default true;

create table if not exists whatsapp_private.appointment_reminders (
  appointment_id uuid primary key,
  company_id     uuid not null references companies (id) on delete cascade,
  status         text not null check (status in ('queued', 'skipped')),
  reason         text check (reason is null or reason in (
                   'disabled', 'late_booking', 'archived', 'blocked', 'no_phone', 'invalid_phone',
                   'landline', 'no_client', 'error')),
  outbox_id      uuid references whatsapp_private.outbox (id) on delete set null,
  remind_date    date not null,   -- a véspera (data de São Paulo) em que o lembrete foi decidido
  created_at     timestamptz not null default now(),
  constraint wa_reminder_shape check ((status = 'queued' and reason is null)
                                     or (status = 'skipped' and reason is not null and outbox_id is null))
);
create index if not exists wa_reminders_company_idx on whatsapp_private.appointment_reminders (company_id, remind_date);
create index if not exists wa_reminders_outbox_idx on whatsapp_private.appointment_reminders (outbox_id);
alter table whatsapp_private.appointment_reminders enable row level security;


-- 2. TEXTO DO LEMBRETE (6 variações; mesmo tom da confirmação; sem assinatura) ----
-- "amanhã" é seguro: a fila cancela o lembrete que não sair na mesma noite.
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
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. Te esperamos! 💕';
    when 1 then v_greet := v_oitb;
      v_body := 'Só lembrando do seu horário' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ' ' || v_dia || ', ' || v_hora || '. Até amanhã!';
    when 2 then v_greet := v_oi;
      v_body := 'Amanhã é dia de se cuidar! Seu horário' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ' está marcado para ' || v_wd || ' (' || v_ddmm || '), ' || v_hora || '. ✨';
    when 3 then v_greet := v_oi;
      v_body := 'Lembrete do seu agendamento' || case when v_sv <> '' then ' de ' || v_sv else '' end
                || ': ' || v_dia || ', ' || v_hora || '. Qualquer imprevisto, é só avisar por aqui.';
    when 4 then v_greet := v_oitb;
      v_body := 'Amanhã tem horário marcado com a gente: ' || v_wd || ' (' || v_ddmm || '), ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. Vai ser um prazer te receber! 🌸';
    else v_greet := v_oi;
      v_body := 'Passando para lembrar que te esperamos ' || v_dia || ', ' || v_hora
                || case when v_sv <> '' then ', para ' || v_sv else '' end || '. Se precisar remarcar, é só chamar por aqui.';
  end case;

  return v_greet || E'\n\n' || v_body;
end;
$$;


-- 3. DISPARO (chamado pela tarefa da 0021; idempotente) -------------------------------
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


-- 4. FILA: claim_outbox da 0018 + regras do lembrete (a2, b2) ----------------------------
create or replace function whatsapp_private.claim_outbox(p_worker_id text, p_limit int default 10, p_lock_seconds int default 60,
                                                       p_kinds text[] default null)
returns setof whatsapp_private.outbox
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := greatest(1, least(p_limit, 100));
  v_lock interval := make_interval(secs => greatest(10, least(p_lock_seconds, 600)));
  v_n int;
begin
  if p_kinds is null or 'send_text' = any (p_kinds) then
    -- (a) confirmação de agendamento que não vale mais
    update whatsapp_private.outbox o
    set status = 'canceled', last_error = 'agendamento não está mais em aberto', locked_by = null, locked_until = null,
        updated_at = now()
    from whatsapp_private.sessions s
    where o.kind = 'send_text' and o.appointment_id is not null
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
      and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
      and not exists (select 1 from appointments a
                      where a.id = o.appointment_id and a.company_id = o.company_id and a.client_id = o.client_id
                        and a.status in ('agendado', 'confirmado') and a.scheduled_start > now());

    -- (b) confirmação automática pendente: refeita com os dados de agora
    update whatsapp_private.outbox o
    set body = x.body, to_phone = x.phone, updated_at = now()
    from (
      select o2.id, whatsapp_private.confirmation_text(o2.appointment_id) as body, cl.phone_normalized as phone
      from whatsapp_private.outbox o2
      join whatsapp_private.appointment_confirmations ac on ac.outbox_id = o2.id
      join whatsapp_private.sessions s on s.company_id = o2.company_id
      join clients cl on cl.id = o2.client_id and cl.company_id = o2.company_id
      where o2.kind = 'send_text' and o2.status = 'pending'
        and s.lease_owner = p_worker_id and s.lease_until > now()
    ) x
    where o.id = x.id and x.body is not null and x.phone is not null
      and (o.body is distinct from x.body or o.to_phone is distinct from x.phone);

    -- (a2) [0020] LEMBRETE: só vale na mesma noite em que foi decidido e para o
    --      agendamento que continua sendo "amanhã"; senão é cancelado (nunca sai
    --      lembrete com "amanhã" errado, mesmo se o worker ficou fora do ar).
    update whatsapp_private.outbox o
    set status = 'canceled', last_error = 'lembrete fora do prazo', locked_by = null, locked_until = null,
        updated_at = now()
    from whatsapp_private.appointment_reminders ar, whatsapp_private.sessions s
    where ar.outbox_id = o.id and o.kind = 'send_text'
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
      and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
      and ((now() at time zone 'America/Sao_Paulo')::date <> ar.remind_date
           or not exists (select 1 from appointments a
                          where a.id = o.appointment_id
                            and (a.scheduled_start at time zone 'America/Sao_Paulo')::date = ar.remind_date + 1));

    -- (b2) [0020] LEMBRETE pendente: texto e telefone refeitos com os dados de agora
    update whatsapp_private.outbox o
    set body = x.body, to_phone = x.phone, updated_at = now()
    from (
      select o2.id, whatsapp_private.reminder_text(o2.appointment_id) as body, cl.phone_normalized as phone
      from whatsapp_private.outbox o2
      join whatsapp_private.appointment_reminders ar on ar.outbox_id = o2.id
      join whatsapp_private.sessions s on s.company_id = o2.company_id
      join clients cl on cl.id = o2.client_id and cl.company_id = o2.company_id
      where o2.kind = 'send_text' and o2.status = 'pending'
        and s.lease_owner = p_worker_id and s.lease_until > now()
    ) x
    where o.id = x.id and x.body is not null and x.phone is not null
      and (o.body is distinct from x.body or o.to_phone is distinct from x.phone);
  end if;

  -- (c) cliente que não pode mais receber
  update whatsapp_private.outbox o
  set status = 'canceled', last_error = 'cliente não pode mais receber: ' || whatsapp_private.recipient_block(c),
      updated_at = now()
  from clients c, whatsapp_private.sessions s
  where o.kind = 'send_text' and o.status = 'pending'
    and (p_kinds is null or 'send_text' = any (p_kinds))
    and c.id = o.client_id and c.company_id = o.company_id
    and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
    and whatsapp_private.recipient_block(c) is not null;

  -- (d) conectar / desconectar
  return query
  with c as (
    select o.id from whatsapp_private.outbox o
    join whatsapp_private.sessions s on s.company_id = o.company_id
    where o.kind <> 'send_text'
      and (p_kinds is null or o.kind = any (p_kinds))
      and s.lease_owner = p_worker_id and s.lease_until > now()
      and o.available_at <= now()
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
    order by o.created_at
    limit v_limit
    for update of o skip locked
  )
  update whatsapp_private.outbox o
  set status = 'processing', locked_by = p_worker_id, locked_until = now() + v_lock,
      attempts = o.attempts + 1, updated_at = now()
  from c where o.id = c.id
  returning o.*;
  get diagnostics v_n = row_count;
  if v_n >= v_limit or (p_kinds is not null and not ('send_text' = any (p_kinds))) then
    return;
  end if;

  -- (e) envios (cliente revalidada com trava compartilhada; sessão conectada)
  return query
  with c as (
    select o.id from whatsapp_private.outbox o
    join whatsapp_private.sessions s on s.company_id = o.company_id
    join clients cl on cl.id = o.client_id and cl.company_id = o.company_id
    where o.kind = 'send_text'
      and s.lease_owner = p_worker_id and s.lease_until > now()
      and s.status = 'connected'
      and o.available_at <= now()
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
      and whatsapp_private.recipient_block(cl) is null
    order by o.created_at
    limit v_limit - v_n
    for update of o skip locked
    for share of cl
  )
  update whatsapp_private.outbox o
  set status = 'processing', locked_by = p_worker_id, locked_until = now() + v_lock,
      attempts = o.attempts + 1, updated_at = now()
  from c where o.id = c.id
  returning o.*;
end;
$$;


-- 5. PRIVILÉGIOS: nada novo para a API nem para o worker -----------------------------------
revoke all on whatsapp_private.appointment_reminders from public;
revoke all on function whatsapp_private.reminder_text(uuid, timestamptz),
                       whatsapp_private.enqueue_day_before_reminders(timestamptz) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on whatsapp_private.appointment_reminders from %I', r);
      execute format('revoke all on function whatsapp_private.reminder_text(uuid, timestamptz), whatsapp_private.enqueue_day_before_reminders(timestamptz) from %I', r);
    end if;
  end loop;
end $$;
