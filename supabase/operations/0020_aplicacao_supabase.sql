-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0020 + 0021 (LEMBRETE da véspera às 18h) NO SUPABASE
--
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Pré-requisito: 0018 (e 0019) aplicadas; pg_cron
-- habilitado (já está, pela 0016). Tudo nasce DESLIGADO: aplicar não envia nada.
-- Ligar é o bloco [B5]; desligar de emergência, [B6].
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f | 0 | t
select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'appointment_confirmations') as tem_0018,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'appointment_reminders') as tem_0020,
       (select count(*) from cron.job where jobname = 'aurea-wa-day-before-reminder') as job_lembrete,
       exists (select 1 from pg_extension where extname = 'pg_cron') as tem_pg_cron;
-- [/B0]

-- [B2] APLICAR: 0020_whatsapp_day_before_reminder.sql e depois 0021_schedule_day_before_reminder.sql.

-- [B3] DEPOIS (só leitura). Esperado: t | f | 1 | */15 21-23 * * * | 13 | 0
select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'whatsapp_private' and c.relname = 'appointment_reminders') as tem_0020,
       (select reminder_enabled from whatsapp_private.settings) as lembrete_ligado,
       (select count(*) from cron.job where jobname = 'aurea-wa-day-before-reminder') as job_lembrete,
       (select schedule from cron.job where jobname = 'aurea-wa-day-before-reminder') as agenda_utc,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas;
-- [/B3]

-- [B4] ACOMPANHAMENTO (só leitura; sem telefone nem texto)
select r.remind_date, r.status, coalesce(r.reason, o.status) as detalhe, count(*)
from whatsapp_private.appointment_reminders r
left join whatsapp_private.outbox o on o.id = r.outbox_id
where r.remind_date > current_date - 7
group by 1, 2, 3 order by 1 desc, 2, 3;
-- [/B4]

-- [B5] LIGAR o lembrete. Vale a partir da próxima rodada das 18h. Esperado: true
update whatsapp_private.settings set reminder_enabled = true where id returning reminder_enabled;
-- [/B5]

-- [B6] DESLIGAR (emergência): para de disparar e cancela lembretes ainda não enviados.
begin;
update whatsapp_private.settings set reminder_enabled = false where id;
update whatsapp_private.outbox set status = 'canceled', last_error = 'lembrete desligado', updated_at = now()
where idempotency_key like 'reminder:%' and status = 'pending';
commit;
-- [/B6]

-- [BR] REVERSÃO da 0020 + 0021 (volta exatamente ao estado da 0019).
-- [BR-SQL]
begin;
select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-day-before-reminder';
update whatsapp_private.outbox set status = 'canceled', last_error = '0020 revertida', locked_by = null, locked_until = null, updated_at = now()
where idempotency_key like 'reminder:%' and status in ('pending', 'processing');
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
drop function if exists whatsapp_private.enqueue_day_before_reminders(timestamptz), whatsapp_private.reminder_text(uuid, timestamptz);
drop table if exists whatsapp_private.appointment_reminders;
alter table whatsapp_private.sessions drop column if exists reminder;
alter table whatsapp_private.settings drop column if exists reminder_enabled;
commit;
-- [/BR-SQL]
