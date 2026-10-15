-- ---------------------------------------------------------------------------
-- 0023 — WhatsApp: AVISO de REMARCAÇÃO e de CANCELAMENTO para a cliente
--
-- Nasce DESLIGADO (whatsapp_private.settings.change_notices_enabled = false).
-- Não altera a confirmação (0018/0019) nem o lembrete (0020/0021).
--
-- Quem decide é um gatilho AFTER UPDATE em appointments, NA MESMA TRANSAÇÃO da
-- alteração: se a alteração não for gravada, o aviso não existe; o envio é feito
-- depois, pela fila e pelo worker, e falha no WhatsApp nunca desfaz a alteração.
--
--   REMARCAÇÃO: agendamento em aberto (agendado/confirmado) que continua em
--     aberto, MESMA cliente, e mudou o DIA/HORÁRIO ou o SERVIÇO, com o novo
--     horário no futuro. Profissional, valor, duração e observação não avisam.
--   CANCELAMENTO: agendamento em aberto, horário no futuro, que vira 'cancelado'.
--
--   * Confirmação automática ainda NÃO enviada (pendente): não há aviso — na
--     remarcação ela sai com os dados novos; no cancelamento ela é cancelada.
--   * Aviso de remarcação ainda pendente: não cria outro; o pendente é refeito
--     com os dados finais na hora do envio (várias edições = 1 aviso).
--   * 1 aviso de cancelamento por agendamento (índice único + chave 'cancel:<id>').
--   * Na fila: remarcação deixa de valer se o agendamento não estiver mais em
--     aberto/futuro ou trocar de cliente; cancelamento deixa de valer se o
--     agendamento for reaberto/apagado ou o horário já tiver passado.
--   * Mesmas regras de destinatária (celular válido, não arquivada, sem SAIR),
--     isolamento por empresa e a preferência da empresa (sessions.auto_confirmation).
--   * WhatsApp desconectado de propósito: registra 'not_connected' e não envia;
--     fora do ar momentaneamente (connecting): fica na fila até voltar.
--   * Troca de cliente: nenhuma mensagem automática.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'whatsapp_private' and c.relname = 'appointment_reminders') then
    raise exception '0023 ABORTADA — nada foi alterado. Aplique antes a 0020.' using errcode = '55000';
  end if;
end $$;

-- 1. CONFIGURAÇÃO E REGISTRO -------------------------------------------------------
alter table whatsapp_private.settings
  add column if not exists change_notices_enabled boolean not null default false;

create table if not exists whatsapp_private.appointment_notices (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null,
  company_id     uuid not null references companies (id) on delete cascade,
  kind           text not null check (kind in ('reschedule', 'cancel')),
  status         text not null check (status in ('queued', 'skipped')),
  reason         text check (reason is null or reason in (
                   'disabled', 'not_connected', 'confirmation_pending', 'archived', 'blocked', 'no_phone',
                   'invalid_phone', 'landline', 'no_client', 'rate_limited', 'error')),
  outbox_id      uuid references whatsapp_private.outbox (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint wa_notice_shape check ((status = 'queued' and reason is null)
                                   or (status = 'skipped' and reason is not null and outbox_id is null))
);
create unique index if not exists wa_notices_one_cancel on whatsapp_private.appointment_notices (appointment_id) where kind = 'cancel';
create index if not exists wa_notices_appt_idx on whatsapp_private.appointment_notices (appointment_id, created_at desc);
create index if not exists wa_notices_outbox_idx on whatsapp_private.appointment_notices (outbox_id);
alter table whatsapp_private.appointment_notices enable row level security;


-- 2. TEXTOS (sem assinatura; mesmo tom da confirmação) -----------------------------
-- Partes comuns: 1º nome, serviço, "no dia 15/10 (quinta-feira)" / "o dia ..." /
-- "amanhã, quinta-feira (15/10)", "às 14h30" e a semente da variação (muda a
-- cada novo horário, para remarcações seguidas não repetirem o texto).
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

-- REMARCAÇÃO: 6 variações (emoji em 3), com os dados NOVOS
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
      v_body := 'Seu horário foi alterado! Agora te esperamos ' || p.em || ', ' || p.hora
                || case when p.sv <> '' then ', para ' || p.sv else '' end || '. 💕';
    when 1 then v_greet := v_oitb;
      v_body := 'Passando para avisar que seu agendamento' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' mudou: o novo horário é ' || p.em || ', ' || p.hora || '. Qualquer dúvida, é só chamar por aqui.';
    when 2 then v_greet := v_oi;
      v_body := 'Seu agendamento foi remarcado para ' || p.para || ', ' || p.hora
                || case when p.sv <> '' then ', para ' || p.sv else '' end || '. Te esperamos! ✨';
    when 3 then v_greet := v_oi;
      v_body := 'Tudo certo com a mudança: seu horário' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' agora é ' || p.em || ', ' || p.hora || '. Até lá!';
    when 4 then v_greet := v_oitb;
      v_body := 'Seu horário' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' mudou para ' || p.para || ', ' || p.hora || '. Se precisar de outro horário, é só avisar por aqui. 🌸';
    else v_greet := v_oi;
      v_body := 'Só para avisar: seu agendamento' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' ficou para ' || p.para || ', ' || p.hora || '. Qualquer imprevisto, é só chamar por aqui.';
  end case;
  return v_greet || E'\n\n' || v_body;
end;
$$;

-- CANCELAMENTO: 4 variações (emoji em 1). Deixa claro que NÃO vale mais.
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
                || ' ' || p.em || ', ' || p.hora || ', foi cancelado. Se quiser marcar um novo horário, é só chamar por aqui.';
    when 1 then v_greet := v_oitb;
      v_body := 'Seu horário' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' ' || p.em || ', ' || p.hora || ', foi cancelado. Quando quiser remarcar, estamos por aqui. 💕';
    when 2 then v_greet := v_oi;
      v_body := 'Só para avisar: o seu agendamento ' || p.em || ', ' || p.hora
                || case when p.sv <> '' then ', para ' || p.sv else '' end
                || ', foi cancelado. Se precisar, é só chamar por aqui para marcar outro horário.';
    else v_greet := v_oi;
      v_body := 'Seu agendamento' || case when p.sv <> '' then ' de ' || p.sv else '' end
                || ' ' || p.em || ', ' || p.hora || ', foi cancelado. Qualquer coisa, é só falar com a gente por aqui.';
  end case;
  return v_greet || E'\n\n' || v_body;
end;
$$;


-- 3. GATILHO: alteração gravada → aviso na fila (mesma transação) -------------------
create or replace function whatsapp_private.on_appointment_changed()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_on boolean; v_pref boolean; v_sess text; v_kind text;
  c clients%rowtype; v_reason text; v_id uuid := gen_random_uuid(); v_body text; r jsonb;
begin
  select change_notices_enabled into v_on from whatsapp_private.settings where id;
  if not coalesce(v_on, false) then return null; end if;

  if old.status in ('agendado', 'confirmado') and new.status = 'cancelado' and old.scheduled_start > now() then
    v_kind := 'cancel';
  elsif old.status in ('agendado', 'confirmado') and new.status in ('agendado', 'confirmado')
        and new.client_id = old.client_id
        and (new.scheduled_start is distinct from old.scheduled_start or new.service_id is distinct from old.service_id)
        and new.scheduled_start > now() then
    v_kind := 'reschedule';
  else
    return null;
  end if;

  select s.auto_confirmation, s.status into v_pref, v_sess from whatsapp_private.sessions s where s.company_id = new.company_id;
  if not found then return null; end if;   -- empresa sem WhatsApp: nada

  begin
    if exists (select 1 from whatsapp_private.appointment_confirmations ac
               join whatsapp_private.outbox o on o.id = ac.outbox_id
               where ac.appointment_id = new.id and o.status = 'pending') then
      v_reason := 'confirmation_pending';   -- a confirmação leva os dados novos / é cancelada na fila
    elsif v_kind = 'reschedule' and exists (
            select 1 from whatsapp_private.appointment_notices an
            join whatsapp_private.outbox o on o.id = an.outbox_id
            where an.appointment_id = new.id and an.kind = 'reschedule' and o.status = 'pending') then
      return null;                          -- o aviso pendente será refeito com os dados finais
    elsif not v_pref then
      v_reason := 'disabled';
    elsif v_sess not in ('connected', 'connecting') then
      v_reason := 'not_connected';
    else
      select * into c from clients where id = new.client_id and company_id = new.company_id;
      v_reason := case when not found then 'no_client' else whatsapp_private.recipient_block(c) end;
    end if;

    if v_reason is null then
      begin
        v_body := case v_kind when 'cancel' then whatsapp_private.cancel_notice_text(new.id)
                              else whatsapp_private.reschedule_notice_text(new.id) end;
        r := whatsapp_private.enqueue_send(new.company_id, c.id, new.id, c.phone_normalized, v_body,
               case v_kind when 'cancel' then 'cancel:' || new.id else 'reschedule:' || new.id || ':' || v_id end);
        insert into whatsapp_private.appointment_notices (id, appointment_id, company_id, kind, status, outbox_id)
        values (v_id, new.id, new.company_id, v_kind, 'queued', (r ->> 'outbox_id')::uuid)
        on conflict do nothing;
        return null;
      exception when others then
        v_reason := case when sqlstate = 'AUW03' then 'rate_limited' else 'error' end;
        raise warning 'aviso de alteração não enfileirado (%)', sqlstate;   -- sem dados pessoais
      end;
    end if;

    insert into whatsapp_private.appointment_notices (id, appointment_id, company_id, kind, status, reason)
    values (v_id, new.id, new.company_id, v_kind, 'skipped', v_reason)
    on conflict do nothing;
  exception when others then
    raise warning 'aviso de alteração ignorado (%)', sqlstate;   -- NUNCA desfaz a alteração
  end;
  return null;
end;
$$;

drop trigger if exists trg_appointments_wa_change_notice on appointments;
create trigger trg_appointments_wa_change_notice
  after update of status, scheduled_start, service_id, client_id on appointments
  for each row execute function whatsapp_private.on_appointment_changed();


-- 4. FILA: claim_outbox da 0020 + regras dos avisos (exceção em a; a3; b3) ----------
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
                        and a.status in ('agendado', 'confirmado') and a.scheduled_start > now())
      and not exists (select 1 from whatsapp_private.appointment_notices an   -- [0023] aviso de cancelamento: regra própria (a3)
                      where an.outbox_id = o.id and an.kind = 'cancel');

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

    -- (a3) [0023] AVISO DE CANCELAMENTO: só sai se o agendamento continua cancelado,
    --      com a mesma cliente, e o horário cancelado ainda não passou.
    update whatsapp_private.outbox o
    set status = 'canceled', last_error = 'aviso de cancelamento fora do prazo', locked_by = null, locked_until = null,
        updated_at = now()
    from whatsapp_private.appointment_notices an, whatsapp_private.sessions s
    where an.outbox_id = o.id and an.kind = 'cancel' and o.kind = 'send_text'
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until < now()))
      and s.company_id = o.company_id and s.lease_owner = p_worker_id and s.lease_until > now()
      and not exists (select 1 from appointments a
                      where a.id = o.appointment_id and a.company_id = o.company_id and a.client_id = o.client_id
                        and a.status = 'cancelado' and a.scheduled_start > now());

    -- (b3) [0023] AVISOS pendentes (remarcação/cancelamento): texto e telefone refeitos agora
    update whatsapp_private.outbox o
    set body = x.body, to_phone = x.phone, updated_at = now()
    from (
      select o2.id,
             case an.kind when 'cancel' then whatsapp_private.cancel_notice_text(o2.appointment_id)
                          else whatsapp_private.reschedule_notice_text(o2.appointment_id) end as body,
             cl.phone_normalized as phone
      from whatsapp_private.outbox o2
      join whatsapp_private.appointment_notices an on an.outbox_id = o2.id
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


-- 5. RPC DO APP: situação do último aviso de um agendamento (sem telefone nem texto)
--   kind: reschedule | cancel ; state: none | skipped | queued | retrying | sending | sent | delivered | read | failed | canceled
create or replace function wa_get_change_notice(p_appointment_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  a appointments%rowtype;
  an whatsapp_private.appointment_notices%rowtype;
  o whatsapp_private.outbox%rowtype;
  v_msg text; v_state text;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode = '28000'; end if;
  select * into a from appointments where id = p_appointment_id;
  if not found or whatsapp_private.caller_role(a.company_id) is null then
    raise exception 'Agendamento não encontrado.' using errcode = 'P0002';
  end if;
  select * into an from whatsapp_private.appointment_notices
  where appointment_id = a.id and company_id = a.company_id order by created_at desc limit 1;
  if not found then return jsonb_build_object('state', 'none'); end if;
  if an.status = 'skipped' then
    return jsonb_build_object('kind', an.kind, 'state', 'skipped', 'reason', an.reason);
  end if;
  select * into o from whatsapp_private.outbox where id = an.outbox_id;
  if not found then return jsonb_build_object('kind', an.kind, 'state', 'none'); end if;
  v_state := case o.status when 'pending' then case when o.attempts > 0 then 'retrying' else 'queued' end
                           when 'processing' then 'sending' else o.status end;
  if o.status = 'sent' then
    select m.status into v_msg from whatsapp_private.messages m
    where m.company_id = o.company_id and m.outbox_id = o.id and m.direction = 'out' order by m.created_at desc limit 1;
    if v_msg in ('delivered', 'read', 'failed') then v_state := v_msg; end if;
  end if;
  return jsonb_build_object('kind', an.kind, 'state', v_state);
end;
$$;


-- 6. PRIVILÉGIOS ---------------------------------------------------------------------
revoke all on whatsapp_private.appointment_notices from public;
revoke all on function whatsapp_private.notice_parts(uuid, timestamptz), whatsapp_private.reschedule_notice_text(uuid, timestamptz),
  whatsapp_private.cancel_notice_text(uuid, timestamptz), whatsapp_private.on_appointment_changed() from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'wa_worker'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on whatsapp_private.appointment_notices from %I', r);
      execute format('revoke all on function whatsapp_private.notice_parts(uuid, timestamptz), whatsapp_private.reschedule_notice_text(uuid, timestamptz), whatsapp_private.cancel_notice_text(uuid, timestamptz), whatsapp_private.on_appointment_changed() from %I', r);
    end if;
  end loop;
end $$;
revoke all on function wa_get_change_notice(uuid) from public, anon;
grant execute on function wa_get_change_notice(uuid) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function wa_get_change_notice(uuid) from service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
