-- ---------------------------------------------------------------------------
-- 0026 — Lembrete da véspera passa a rodar às 8h (pg_cron)
--
-- pg_cron usa UTC (GMT no Supabase). Brasília = UTC-3, sem horário de verão:
-- 11:00–13:45 UTC = 08:00–10:45 em São Paulo, a cada 15 min (antes 18:00–20:45).
-- A função (0025) só age a partir das 8h e é idempotente; as rodadas seguintes
-- só pegam o que ficou para trás (WhatsApp sem sinal, limite de ritmo).
-- Reaplicar é seguro: o job é recriado sem duplicar.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_day_before_reminders') then
    raise exception '0026 ABORTADA — nada foi alterado. Aplique antes a 0020.' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception '0026 ABORTADA — a extensão pg_cron não está habilitada (ver 0016).' using errcode = '55000';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-day-before-reminder';
select cron.schedule(
  'aurea-wa-day-before-reminder',
  '*/15 11-13 * * *',
  $job$select whatsapp_private.enqueue_day_before_reminders()$job$
);
