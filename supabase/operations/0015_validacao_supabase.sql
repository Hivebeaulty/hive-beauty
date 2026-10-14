-- ============================================================================
-- ÁUREA — VALIDAÇÃO DA 0015 NO SUPABASE (produção) — ROTEIRO
--
-- Escopo: aplicar a 0015 (que nasce DESLIGADA) e rodar os testes seguros.
-- NÃO aplica a 0016, NÃO regulariza os R$ 250, NÃO ativa a automação.
--
-- Como usar: cada bloco [Vx] é independente. Selecione só o bloco e use
-- "Run selected". Anote/print os resultados de V0.8 (FOTO ANTES): eles são
-- comparados com V2.3 e V4.1.
-- Faça tudo num horário sem uso do app (assim as fotos batem por inteiro).
-- ============================================================================


-- ============================== ETAPA 0 — ANTES (somente leitura) ==============

-- [V0.1] Ambiente. Esperado: usuario = postgres; protecoes_0014 = 5;
--        schema_privado = false; job_cron = 0; usuarios_auth >= 1.
select version() as versao,
       current_user as usuario,
       (select count(*) from pg_trigger where tgname in (
          'trg_payments_track_origin','trg_appointments_guard_lifecycle',
          'trg_appointments_payment_consistency_ins','trg_appointments_payment_consistency_upd',
          'trg_payments_appointment_consistency') and tgenabled = 'O')                 as protecoes_0014,
       exists (select 1 from pg_namespace where nspname = 'aurea_private')            as schema_privado,
       (select count(*) from pg_extension where extname = 'pg_cron')                  as pg_cron_habilitado,
       -- (consulta dinâmica: funciona mesmo com o pg_cron desabilitado, sem citar cron.job)
       case when exists (select 1 from pg_extension where extname = 'pg_cron')
            then (xpath('/row/c/text()', query_to_xml(
                   'select count(*) as c from cron.job where jobname = ''aurea-auto-conclusion''', false, true, '')))[1]::text::int
            else 0 end as job_cron,
       (select count(*) from auth.users)                                              as usuarios_auth;
-- [/V0.1]

-- [V0.2] Gatilhos nas tabelas públicas fora do esperado. Esperado: 0 linhas.
--        (Uma linha aqui — por exemplo um Database Webhook — exige revisão
--        antes de seguir: os testes inserem dados temporários nessas tabelas.)
select c.relname as tabela, t.tgname as gatilho, p.proname as funcao
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal
  and t.tgname not in (
    'trg_appointments_block_delete_with_payment','trg_appointments_guard_lifecycle',
    'trg_appointments_payment_consistency_ins','trg_appointments_payment_consistency_upd',
    'trg_audit_appointments','trg_log_appointment_status','trg_audit_clients',
    'trg_clients_block_delete_with_history','trg_clients_comm_status','trg_clients_company_id_immutable',
    'trg_audit_members','trg_audit_expenses','trg_audit_payments','trg_normalize_payment_amount',
    'trg_payments_appointment_consistency','trg_payments_track_origin','trg_audit_services')
order by 1, 2;
-- [/V0.2]

-- [V0.3] Funções do schema público que fazem chamadas externas (HTTP, dblink).
--        Esperado: 0 linhas. Chamadas externas NÃO seriam desfeitas pelo rollback.
select p.proname as funcao
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc ~* '(net\.http_|http_(get|post|put|request)|dblink|supabase_functions\.http_request)';
-- [/V0.3]

-- [V0.4] Isolamento dos testes (eles usam junho/2020 e empresas 'ZZ-TESTE-').
--        Esperado: as duas colunas = 0.
select (select count(*) from appointments
         where scheduled_start < timestamptz '2021-01-01' or scheduled_end < timestamptz '2021-01-01') as atendimentos_ate_2020,
       (select count(*) from companies where name like 'ZZ-%')                                         as empresas_de_teste;
-- [/V0.4]

-- [V0.5] Dono das tabelas públicas (a 0015 cria índices nelas). Esperado: 0 linhas.
select tablename, tableowner from pg_tables
where schemaname = 'public' and tableowner <> current_user
order by 1;
-- [/V0.5]

-- [V0.6] Tamanho das tabelas que recebem índice (dimensiona a trava de escrita). Informativo.
select (select count(*) from appointments) as atendimentos,
       (select count(*) from audit_logs) as auditoria,
       (select count(*) from appointment_status_history) as historico;
-- [/V0.6]

-- [V0.7] Os 3 registros sensíveis. Esperado: 1 concluído sem recebimento (R$ 90)
--        e os 2 em aberto a regularizar (R$ 100 e R$ 150), sem recebimento.
select a.id, a.status, a.price,
       to_char(a.scheduled_end at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as fim_sp,
       (select count(*) from payments p where p.appointment_id = a.id) as recebimentos,
       md5(to_jsonb(a)::text) as hash_linha
from appointments a
where (a.status = 'concluido' and not exists (select 1 from payments p where p.appointment_id = a.id))
   or a.id in ('f077bf3d-5507-441a-8114-b3493ebd640b', '674b1ea5-3bbc-46dd-bd39-2799f0f51a35')
order by a.price;
-- [/V0.7]

-- [V0.8] FOTO (rode ANTES, de novo em V2.3 e em V4.1; os valores precisam ser iguais)
select 'dados ' || nome as item, linhas::text as valor, hash
from (
  select 'appointments' nome, count(*) linhas, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) hash from appointments x
  union all select 'payments', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from payments x
  union all select 'clients', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from clients x
  union all select 'companies', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from companies x
  union all select 'company_members', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from company_members x
  union all select 'services', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from services x
  union all select 'expenses', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from expenses x
  union all select 'appointment_status_history', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from appointment_status_history x
  union all select 'profiles', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from profiles x
  union all select 'audit_logs (quantidade)', count(*), '' from audit_logs
) d
union all
select 'definicoes do schema public (funções, gatilhos, policies, constraints)', '',
       md5(string_agg(def, '|' order by def))
from (
  select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f', 'p')
  union all select pg_get_triggerdef(t.oid) || t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal
  union all select pol.polname || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
   from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
  union all select conname || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
) z
union all
select 'registro R$ 90 (concluído sem recebimento)', count(*)::text, md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), ''))
from appointments a
where a.status = 'concluido' and not exists (select 1 from payments p where p.appointment_id = a.id)
union all
select 'os 2 a regularizar (R$ 250)', count(*)::text, md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), ''))
from appointments a
where a.id in ('f077bf3d-5507-441a-8114-b3493ebd640b', '674b1ea5-3bbc-46dd-bd39-2799f0f51a35')
order by 1;
-- [/V0.8]


-- ============================== ETAPA 1 — APLICAR A 0015 =========================
-- Numa NOVA query, escreva "begin;" na primeira linha, cole o arquivo
-- 0015_auto_conclusion.sql inteiro e escreva "commit;" na última linha.
-- Clique em Run (sem seleção). Esperado: "Success. No rows returned".
-- Se der QUALQUER erro: a transação é desfeita inteira (nada aplicado).
-- Não tente de novo; envie a mensagem.


-- ============================== ETAPA 2 — DEPOIS DE APLICAR (somente leitura) ======

-- [V2.1] Objetos criados. Esperado: true | 4 | 10 | 2 | 3 | false | null | 0 | 0 | 0 | 0
select exists (select 1 from pg_namespace where nspname = 'aurea_private')                      as schema_privado,
       (select count(*) from pg_tables where schemaname = 'aurea_private')                       as tabelas,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'aurea_private')                                                       as funcoes,
       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'aurea_private' and not t.tgisinternal)                                as gatilhos_config,
       (select count(*) from pg_indexes where indexname in ('appointments_open_scheduled_end_idx',
         'audit_logs_entity_entity_id_idx', 'appointment_status_history_appointment_id_idx'))    as indices_novos,
       (select enabled from aurea_private.settings)                                              as automacao_ligada,
       (select process_from from aurea_private.settings)                                         as data_inicio,
       (select count(*) from aurea_private.runs)                                                 as execucoes,
       (select count(*) from aurea_private.run_items)                                            as itens,
       (select count(*) from aurea_private.appointment_state)                                    as controle,
       -- (consulta dinâmica: funciona mesmo com o pg_cron desabilitado, sem citar cron.job)
       case when exists (select 1 from pg_extension where extname = 'pg_cron')
            then (xpath('/row/c/text()', query_to_xml(
                   'select count(*) as c from cron.job where jobname = ''aurea-auto-conclusion''', false, true, '')))[1]::text::int
            else 0 end as job_cron;
-- [/V2.1]

-- [V2.2] Privilégios: rode as SEÇÕES 1 e 2 de supabase/diagnostics/0015_privileges_audit.sql.
--        Esperado: seção 1 com resultado "ok" em todas as 10 funções;
--        seção 2: funcoes = 10, tabelas = 4, tabelas_sem_rls = 0,
--        papeis_com_acesso_ao_schema = 0, acessos_a_tabelas = 0, funcoes_expostas = 0.
--        Confira também em Settings > API (Exposed schemas) que aurea_private NÃO aparece.

-- [V2.3] Rode de novo a FOTO [V0.8]. Esperado: todas as linhas IGUAIS às de antes.

-- [V2.4] A automação desligada não faz nada. Esperado: {"status": "disabled"}
select aurea_private.run_auto_conclusion();
-- [/V2.4]


-- ============================== ETAPA 3 — TESTES SEGUROS ===========================
-- Numa NOVA query, cole o arquivo 0015_auto_conclusion_producao_sem_ddl.sql
-- inteiro e clique em Run. A mensagem em vermelho é PROPOSITAL (desfaz tudo).
-- Esperado no fim da mensagem: LINHAS "FAIL": 0
-- (82 linhas PASS; "INFO P6" é aceitável se o SQL Editor não puder assumir service_role.)
-- Se aparecer QUALQUER "FAIL": pare e envie o relatório inteiro.


-- ============================== ETAPA 4 — DEPOIS DOS TESTES (somente leitura) =======

-- [V4.1] Rode de novo a FOTO [V0.8]. Esperado: todas as linhas IGUAIS às de antes.

-- [V4.2] Nenhum rastro dos testes. Esperado: 0 | 0 | 0 | 0 | 0 | false | null | null
select (select count(*) from companies where name like 'ZZ-%')                as empresas_de_teste,
       (select count(*) from appointments where scheduled_end < timestamptz '2021-01-01') as atendimentos_2020,
       (select count(*) from aurea_private.runs)                              as execucoes,
       (select count(*) from aurea_private.run_items)                         as itens,
       (select count(*) from aurea_private.appointment_state)                 as controle,
       (select enabled from aurea_private.settings)                           as automacao_ligada,
       (select process_from from aurea_private.settings)                      as data_inicio,
       (select last_run_at from aurea_private.settings)                       as ultima_execucao;
-- [/V4.2]

-- [V4.3] Rode as seções 1 e 8 de diagnostico_regularizacao_atendimentos_v2.sql.
--        Esperado: iguais às de antes (01 = 2 / R$ 250, 06 = 1 / R$ 90; seção 8 toda zero).


-- ============================== REVERSÃO DA 0015 (só se algo der errado) ===========
-- Seguro ANTES da regularização: não toca em nenhum dado de negócio.
-- Remove o schema privado (configuração e logs, todos vazios neste ponto) e os 3 índices.
-- [VR]
begin;
drop schema if exists aurea_private cascade;
drop index if exists public.appointments_open_scheduled_end_idx;
drop index if exists public.audit_logs_entity_entity_id_idx;
drop index if exists public.appointment_status_history_appointment_id_idx;
commit;
-- [/VR]
-- Depois: [V0.1] deve voltar a schema_privado = false e a FOTO [V0.8] deve bater com a de antes.
