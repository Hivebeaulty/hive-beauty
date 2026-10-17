-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0031 + 0032 (mensagem de ANIVERSÁRIO) — ROTEIRO
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Nasce DESLIGADA em todas as empresas: aplicar não envia nada.
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f | 0
select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'whatsapp_private' and c.relname = 'message_templates') as tem_0027,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'whatsapp_private' and c.relname = 'birthday_messages') as tem_0031,
       (select count(*) from cron.job where jobname = 'aurea-wa-birthday') as job_aniversario;
-- [/B0]

-- [B2] APLICAR: 0031_whatsapp_birthday.sql e depois 0032_schedule_birthday.sql.

-- [B3] DEPOIS (só leitura). Esperado: t | 0 | */15 12-14 * * * | 13 | 0
select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'whatsapp_private' and c.relname = 'birthday_messages') as tem_0031,
       (select count(*) from whatsapp_private.message_templates where birthday_enabled) as empresas_com_aniversario_ligado,
       (select schedule from cron.job where jobname = 'aurea-wa-birthday') as agenda_utc,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas;
-- [/B3]

-- [B4] ACOMPANHAMENTO (só leitura; sem telefone nem texto)
select b.year, co.name as empresa, b.status, coalesce(b.reason, o.status) as detalhe, count(*)
from whatsapp_private.birthday_messages b join companies co on co.id = b.company_id
left join whatsapp_private.outbox o on o.id = b.outbox_id
group by 1, 2, 3, 4 order by 1 desc, 2;
-- [/B4]

-- [BR] REVERSÃO da 0032 + 0031 (volta exatamente ao estado da 0030).
-- [BR-SQL]
begin;
select cron.unschedule(jobid) from cron.job where jobname = 'aurea-wa-birthday';
update whatsapp_private.outbox set status = 'canceled', last_error = '0031 revertida', locked_by = null, locked_until = null, updated_at = now()
where idempotency_key like 'birthday:%' and status in ('pending', 'processing');
drop function if exists public.wa_get_birthday_settings(uuid), public.wa_set_birthday_settings(uuid, boolean, text, text);
drop function if exists whatsapp_private.enqueue_birthday_messages(timestamptz), whatsapp_private.birthday_custom_text(text, text, text),
  whatsapp_private.birthday_system_text(text, uuid, int), whatsapp_private.birthday_template_problems(text);
drop table if exists whatsapp_private.birthday_messages;
alter table whatsapp_private.message_templates drop constraint if exists wa_tpl_birthday_mode, drop constraint if exists wa_tpl_birthday_len,
  drop column if exists birthday_enabled, drop column if exists birthday_mode, drop column if exists birthday_template;
notify pgrst, 'reload schema';
commit;
-- [/BR-SQL]
