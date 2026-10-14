-- ============================================================================
-- ÁUREA — AUDITORIA DE PRIVILÉGIOS DA 0015 — SOMENTE LEITURA
-- Rode cada seção separadamente no SQL Editor (selecione e "Run selected").
-- Esperado: seção 1 sem nenhuma linha "EXPOSTA"; seção 2 com exposicoes = 0.
-- ============================================================================

-- SEÇÃO 1 — Detalhe por função privada
select p.oid::regprocedure                                      as funcao,
       pg_get_userbyid(p.proowner)                              as dono,
       case when p.prosecdef then 'DEFINER' else 'invoker' end  as seguranca,
       coalesce((select c from unnest(p.proconfig) c where c like 'search_path=%'), '(SEM search_path)') as search_path,
       has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role_exec,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
                where e.grantee = 0 and e.privilege_type = 'EXECUTE') as public_exec,
       case when p.prosecdef
              or has_function_privilege('anon', p.oid, 'execute')
              or has_function_privilege('authenticated', p.oid, 'execute')
              or has_function_privilege('service_role', p.oid, 'execute')
              or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
                          where e.grantee = 0 and e.privilege_type = 'EXECUTE')
              or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
            then 'EXPOSTA' else 'ok' end                         as resultado
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'aurea_private'
order by 1;

-- SEÇÃO 2 — Resumo (schema, tabelas, funções)
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'aurea_private') as funcoes,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'aurea_private' and c.relkind = 'r') as tabelas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'aurea_private' and c.relkind = 'r' and not c.relrowsecurity) as tabelas_sem_rls,
  (select count(*) from unnest(array['anon','authenticated','service_role']) rl
    where has_schema_privilege(rl, 'aurea_private', 'usage') or has_schema_privilege(rl, 'aurea_private', 'create')) as papeis_com_acesso_ao_schema,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon','authenticated','service_role']) rl
    where n.nspname = 'aurea_private' and c.relkind in ('r','S')
      and has_table_privilege(rl, c.oid, 'select,insert,update,delete')) as acessos_a_tabelas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'aurea_private'
      and (p.prosecdef
           or has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('service_role', p.oid, 'execute')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
                       where e.grantee = 0 and e.privilege_type = 'EXECUTE')
           or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))) as funcoes_expostas,
  (select current_setting('pgrst.db_schemas', true)) as schemas_expostos_postgrest_se_disponivel;

-- SEÇÃO 3 — Job do cron (só existe depois da 0016). Funciona mesmo com o
-- pg_cron desabilitado (consulta dinâmica): sem a 0016, "job" vem vazio.
select exists (select 1 from pg_extension where extname = 'pg_cron') as pg_cron_habilitado,
       case when exists (select 1 from pg_extension where extname = 'pg_cron')
            then query_to_xml('select jobid, jobname, schedule, command, username, active from cron.job
                               where jobname = ''aurea-auto-conclusion''', false, true, '')::text
       end as job;
