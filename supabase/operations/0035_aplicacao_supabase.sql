-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0035 + 0036 (mensagens automáticas por data) — ROTEIRO
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Tudo nasce DESLIGADO: aplicar não envia nada.
-- ============================================================================
-- [B0] ANTES (só leitura). Esperado: t | f | 0
select exists (select 1 from pg_proc where proname = 'enqueue_birthday_messages') as tem_0031,
       exists (select 1 from information_schema.columns where table_name = 'clients' and column_name = 'client_since') as tem_0035,
       (select count(*) from cron.job where jobname = 'aurea-wa-auto-messages') as job;
-- [/B0]
-- [B3] DEPOIS (só leitura). Esperado: t | 0 | */15 12-14 * * * | 13 | 0
select exists (select 1 from information_schema.columns where table_name = 'clients' and column_name = 'client_since') as tem_0035,
       (select count(*) from whatsapp_private.auto_messages where enabled) as ligadas,
       (select schedule from cron.job where jobname = 'aurea-wa-auto-messages') as agenda_utc,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas;
-- [/B3]
-- [BR] REVERSÃO (volta ao estado da 0034; a data "cliente desde" digitada é perdida)
-- [BR-SQL]
begin;
select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-auto-messages';
update whatsapp_private.outbox set status = 'canceled', last_error = '0035 revertida', locked_by = null, locked_until = null, updated_at = now()
where idempotency_key like 'auto:%' and status in ('pending', 'processing');
drop function if exists public.wa_get_auto_messages(uuid), public.wa_set_auto_message(uuid, text, boolean, text, text);
drop function if exists whatsapp_private.enqueue_auto_messages(timestamptz), whatsapp_private.auto_template_problems(text, text),
  whatsapp_private.auto_render(text, text, text, int), whatsapp_private.auto_variant(uuid, text, int), whatsapp_private.auto_system_template(text, int);
drop table if exists whatsapp_private.auto_message_log, whatsapp_private.auto_messages;
alter table clients drop column if exists client_since;
notify pgrst, 'reload schema';
commit;
-- [/BR-SQL]
