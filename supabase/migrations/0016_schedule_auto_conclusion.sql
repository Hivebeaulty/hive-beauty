-- ---------------------------------------------------------------------------
-- 0016 — Agenda a conclusão automática a cada 5 minutos (pg_cron)
--
-- NÃO APLICAR sem autorização explícita.
--
-- Agendar NÃO liga a automação: enquanto aurea_private.settings.enabled for
-- false (padrão da 0015), cada execução apenas retorna {"status":"disabled"} e
-- não grava nada. A automação só passa a concluir atendimentos depois de
-- aurea_private.activate_auto_conclusion(), que exige uma regularização
-- efetivada no mesmo dia (São Paulo).
--
-- O job roda como o papel que o agendou (no Supabase, postgres), dono das
-- funções privadas. Nenhum privilégio é concedido à API.
-- Reaplicar é seguro: o job é recriado sem duplicar.
-- No Supabase, o pg_cron também pode ser habilitado em Database > Extensions
-- (ou Integrations > Cron); o "if not exists" abaixo aceita os dois caminhos.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'aurea_private' and p.proname = 'run_auto_conclusion') then
    raise exception '0016 ABORTADA — nada foi alterado. Aplique antes a migration 0015.' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise exception '0016 ABORTADA — a extensão pg_cron não está disponível neste banco.' using errcode = '55000';
  end if;
end $$;

create extension if not exists pg_cron;

-- recria o job sem duplicar
select cron.unschedule(jobid) from cron.job where jobname = 'aurea-auto-conclusion';
select cron.schedule(
  'aurea-auto-conclusion',
  '*/5 * * * *',
  $job$select aurea_private.run_auto_conclusion()$job$
);
