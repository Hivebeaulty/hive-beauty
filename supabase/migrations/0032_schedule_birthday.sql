-- ---------------------------------------------------------------------------
-- 0032 — Agenda a mensagem de ANIVERSÁRIO (pg_cron)
-- pg_cron usa UTC (GMT no Supabase); Brasília = UTC-3:
-- 12:00–14:45 UTC = 09:00–11:45 em São Paulo, a cada 15 min. A função (0031) só
-- age a partir das 9h, só para empresas que LIGARAM o aniversário, e é idempotente.
-- Reaplicar é seguro: o job é recriado sem duplicar.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'whatsapp_private' and p.proname = 'enqueue_birthday_messages') then
    raise exception '0032 ABORTADA — nada foi alterado. Aplique antes a 0031.' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception '0032 ABORTADA — a extensão pg_cron não está habilitada (ver 0016).' using errcode = '55000';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-birthday';
select cron.schedule(
  'aurea-wa-birthday',
  '*/15 12-14 * * *',
  $job$select whatsapp_private.enqueue_birthday_messages()$job$
);
