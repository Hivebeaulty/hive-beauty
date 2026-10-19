-- ---------------------------------------------------------------------------
-- 0036 — Agenda as mensagens automáticas por data (pg_cron, UTC)
-- 12:00–14:45 UTC = 09:00–11:45 em São Paulo, a cada 15 min. Idempotente.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_auto_messages') then
    raise exception '0036 ABORTADA — nada foi alterado. Aplique antes a 0035.' using errcode = '55000';
  end if;
end $$;
select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-auto-messages';
select cron.schedule('aurea-wa-auto-messages', '*/15 12-14 * * *', $job$select whatsapp_private.enqueue_auto_messages()$job$);
