-- ============================================================================
-- ÁUREA — APLICAÇÃO DA 0017 (WhatsApp W1) NO SUPABASE — ROTEIRO
--
-- NÃO EXECUTE SEM AUTORIZAÇÃO EXPLÍCITA. Esta etapa NÃO cria credencial real,
-- NÃO agenda job e NÃO liga nada: o WhatsApp só passa a funcionar na W2.
-- Cada bloco [Bx] é independente: selecione e use "Run selected".
-- ============================================================================

-- [B0] ANTES (só leitura). Esperado: 5 | 10 | true | false | false | 0
select (select count(*) from pg_trigger where tgenabled = 'O' and tgname in (
          'trg_payments_track_origin','trg_appointments_guard_lifecycle','trg_appointments_payment_consistency_ins',
          'trg_appointments_payment_consistency_upd','trg_payments_appointment_consistency')) as protecoes_0014,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'aurea_private') as funcoes_0015,
       (select enabled from aurea_private.settings) as automacao_ligada,
       exists (select 1 from pg_namespace where nspname = 'whatsapp_private') as schema_whatsapp,
       exists (select 1 from pg_roles where rolname = 'wa_worker') as papel_worker,
       (select count(*) from pg_proc where proname like 'wa\_%') as rpcs_whatsapp;
-- [/B0]

-- [B1] FOTO (rode antes e depois; os valores precisam ser iguais)
select (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from appointments a) as atendimentos,
       (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from payments p) as recebimentos,
       (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from clients c) as clientes,
       (select count(*) from audit_logs) as auditoria,
       (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from appointments a
         where a.status = 'concluido' and not exists (select 1 from payments p where p.appointment_id = a.id)) as registro_r90,
       (select md5(string_agg(x, '|' order by x)) from (
          select to_jsonb(s)::text x from aurea_private.settings s
          union all select to_jsonb(r)::text from aurea_private.runs r where r.kind <> 'scheduled'
          union all select to_jsonb(i)::text from aurea_private.run_items i) z) as automacao;
-- [/B1]

-- [B2] APLICAR: numa nova query, "begin;" + arquivo 0017_whatsapp_core.sql inteiro + "commit;"
--      e Run. Esperado: "Success. No rows returned". Qualquer erro desfaz tudo.

-- [B3] DEPOIS (só leitura). Esperado: true | 7 | 7 | 19 | 13 | false | 0 | 0
select exists (select 1 from pg_namespace where nspname = 'whatsapp_private') as schema_whatsapp,
       (select count(*) from pg_tables where schemaname = 'whatsapp_private' and rowsecurity) as tabelas_com_rls,
       (select count(*) from pg_proc where proname like 'wa\_%') as rpcs_app,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private') as funcoes_privadas,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'whatsapp_private' and has_function_privilege('wa_worker', p.oid, 'execute')) as funcoes_do_worker,
       (select rolcanlogin from pg_roles where rolname = 'wa_worker') as worker_pode_logar,
       (select count(*) from unnest(array['anon','authenticated','service_role']) rl
         where has_schema_privilege(rl, 'whatsapp_private', 'usage')) as papeis_api_no_schema,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join unnest(array['anon','authenticated','service_role']) rl
         where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute')) as funcoes_expostas;
-- [/B3]
-- Depois rode [B1] de novo: tudo igual.

-- [B4] TESTES: nova query com supabase/tests/0017_whatsapp_core_staging.sql inteiro e Run.
--      Erro vermelho proposital; esperado "LINHAS "FAIL": 0". Os testes W* aparecem como
--      INFO se o SQL Editor não puder assumir o papel wa_worker (é esperado no Supabase).
--      Depois, [B1] de novo: tudo igual.

-- [BR] REVERSÃO (só se algo der errado; nesta etapa não há dado de WhatsApp a perder)
-- [BR-SQL]
begin;
drop function if exists public.wa_get_status(uuid), public.wa_request_connection(uuid), public.wa_get_qr(uuid),
  public.wa_disconnect(uuid), public.wa_send_message(uuid, text, text), public.wa_send_confirmation(uuid, text, text),
  public.wa_get_conversation(uuid, int);
drop schema if exists whatsapp_private cascade;
drop role if exists wa_worker;
commit;
-- [/BR-SQL]
