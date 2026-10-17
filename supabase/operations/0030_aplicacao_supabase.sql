-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0030 (editar concluído + lançamento retroativo) — ROTEIRO
-- NÃO EXECUTE SEM AUTORIZAÇÃO. Só cria 2 funções; não altera dados nem envia nada.
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: t | f | f
select exists (select 1 from pg_proc where proname = 'update_appointment') as tem_0022,
       exists (select 1 from pg_proc where proname = 'edit_concluded_appointment') as tem_edicao_concluido,
       exists (select 1 from pg_proc where proname = 'create_retroactive_appointment') as tem_retroativo;
-- [/B0]

-- [B2] APLICAR: 0030_appointment_full_edit_retroactive.sql (transação única).

-- [B3] DEPOIS (só leitura). Esperado: t | t | 0 | 13
select exists (select 1 from pg_proc where proname = 'edit_concluded_appointment') as tem_edicao_concluido,
       exists (select 1 from pg_proc where proname = 'create_retroactive_appointment') as tem_retroativo,
       (select count(*) from pg_proc p cross join unnest(array['anon','service_role']) rl
         where p.proname in ('edit_concluded_appointment','create_retroactive_appointment')
           and has_function_privilege(rl, p.oid, 'execute')) as expostas_fora_do_app,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker;
-- [/B3]

-- [BR] REVERSÃO: remove as 2 funções (os atendimentos já lançados/editados permanecem).
-- [BR-SQL]
begin;
drop function if exists public.edit_concluded_appointment(uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text, jsonb);
drop function if exists public.create_retroactive_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, numeric, payment_status, payment_method, text);
notify pgrst, 'reload schema';
commit;
-- [/BR-SQL]
