-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0022 (edição de agendamento) + 0023 (avisos de
-- remarcação e cancelamento) NO SUPABASE — ROTEIRO
--
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Pré-requisito: 0020/0021 aplicadas.
-- A 0022 só cria a função de edição (a tela nova a usa). A 0023 nasce DESLIGADA:
-- aplicar não envia nada. Ligar os avisos é o bloco [B5]; desligar, [B6].
-- Não alteram a confirmação (0018/0019) nem o lembrete (0020/0021).
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f | f | 0
select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'appointment_reminders') as tem_0020,
       exists (select 1 from pg_proc where proname = 'update_appointment') as tem_0022,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'appointment_notices') as tem_0023,
       (select count(*) from pg_trigger where tgname = 'trg_appointments_wa_change_notice') as gatilho_aviso;
-- [/B0]

-- [B2] APLICAR: 0022_appointment_edit.sql e depois 0023_whatsapp_change_notices.sql.

-- [B3] DEPOIS (só leitura). Esperado: t | t | f | 1 | 13 | 0 | 1
select exists (select 1 from pg_proc where proname = 'update_appointment') as tem_0022,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'appointment_notices') as tem_0023,
       (select change_notices_enabled from whatsapp_private.settings) as avisos_ligados,
       (select count(*) from pg_trigger where tgname = 'trg_appointments_wa_change_notice') as gatilho_aviso,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas,
       (select count(*) from pg_constraint where conname = 'no_overlap_per_professional' and contype = 'x') as trava_sobreposicao;
-- [/B3]

-- [B4] ACOMPANHAMENTO (só leitura; sem telefone nem texto)
select an.created_at::date as dia, an.kind, an.status, coalesce(an.reason, o.status) as detalhe, count(*)
from whatsapp_private.appointment_notices an
left join whatsapp_private.outbox o on o.id = an.outbox_id
where an.created_at > now() - interval '7 days'
group by 1, 2, 3, 4 order by 1 desc, 2, 3;
-- [/B4]

-- [B5] LIGAR os avisos de remarcação e cancelamento. Esperado: true
update whatsapp_private.settings set change_notices_enabled = true where id returning change_notices_enabled;
-- [/B5]

-- [B6] DESLIGAR (emergência): para de gerar avisos e cancela os que ainda não saíram.
begin;
update whatsapp_private.settings set change_notices_enabled = false where id;
update whatsapp_private.outbox set status = 'canceled', last_error = 'avisos desligados', updated_at = now()
where (idempotency_key like 'reschedule:%' or idempotency_key like 'cancel:%') and status = 'pending';
commit;
-- [/B6]

-- [BR] REVERSÃO da 0023 + 0022 (volta exatamente ao estado da 0020/0021).
-- [BR-SQL]
begin;
drop trigger if exists trg_appointments_wa_change_notice on appointments;
update whatsapp_private.outbox set status = 'canceled', last_error = '0023 revertida', locked_by = null, locked_until = null, updated_at = now()
where (idempotency_key like 'reschedule:%' or idempotency_key like 'cancel:%') and status in ('pending', 'processing');
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
drop function if exists public.wa_get_change_notice(uuid);
drop function if exists whatsapp_private.on_appointment_changed(), whatsapp_private.cancel_notice_text(uuid, timestamptz),
  whatsapp_private.reschedule_notice_text(uuid, timestamptz), whatsapp_private.notice_parts(uuid, timestamptz);
drop table if exists whatsapp_private.appointment_notices;
alter table whatsapp_private.settings drop column if exists change_notices_enabled;
drop function if exists public.update_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, jsonb);
notify pgrst, 'reload schema';
commit;
-- [/BR-SQL]
