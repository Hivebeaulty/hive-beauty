-- ---------------------------------------------------------------------------
-- 0021 — Agenda o LEMBRETE da véspera (pg_cron)
--
-- NÃO APLICAR sem autorização. Agendar NÃO liga o lembrete: enquanto
-- whatsapp_private.settings.reminder_enabled for false (padrão da 0020), cada
-- execução só retorna {"status":"disabled"}.
--
-- pg_cron usa UTC. Brasília = UTC-3 (sem horário de verão desde 2019):
-- 21:00–23:45 UTC = 18:00–20:45 em São Paulo, a cada 15 min. A função só age a
-- partir das 18h de São Paulo e é idempotente: as rodadas seguintes só pegam o
-- que ficou para trás (WhatsApp sem sinal, limite de ritmo).
-- Reaplicar é seguro: o job é recriado sem duplicar.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_day_before_reminders') then
    raise exception '0021 ABORTADA — nada foi alterado. Aplique antes a 0020.' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception '0021 ABORTADA — a extensão pg_cron não está habilitada (ver 0016).' using errcode = '55000';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-day-before-reminder';
select cron.schedule(
  'aurea-wa-day-before-reminder',
  '*/15 21-23 * * *',
  $job$select whatsapp_private.enqueue_day_before_reminders()$job$
);
