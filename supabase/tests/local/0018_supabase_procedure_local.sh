#!/usr/bin/env bash
# ============================================================================
# Ensaio LOCAL do roteiro supabase/operations/0018_aplicacao_supabase.sql + preservação.
# Banco com o perfil de produção (0001–0015, regularização feita, automação ativada,
# o concluído sem recebimento de R$ 90) + 0017 aplicada, e privilégios padrão no
# PIOR caso (tudo novo liberado para anon/authenticated/service_role) antes da 0018.
# Prova: a 0018 não muda dados nem definições existentes, não expõe nada, as
# baterias anteriores passam, e a reversão volta EXATAMENTE ao estado da 0017.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_proc_0018"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0013 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
UID_A="$(Q "select id from auth.users order by created_at limit 1")"
Q "
do \$\$
declare c1 uuid; c2 uuid; m1 uuid; m2 uuid; s1 uuid; s2 uuid; k1 uuid; k2 uuid; a uuid; i int;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  insert into companies (name) values ('Studio 1') returning id into c1;
  insert into companies (name) values ('Studio 2') returning id into c2;
  insert into company_members (company_id, user_id, role) values (c1, '$UID_A', 'owner') returning id into m1;
  insert into company_members (company_id, user_id, role) values (c2, '$UID_A', 'owner') returning id into m2;
  insert into services (company_id, name, price) values (c1, 'Mão', 100) returning id into s1;
  insert into services (company_id, name, price) values (c2, 'Pé', 150) returning id into s2;
  insert into clients (company_id, name) values (c1, 'Cliente 1') returning id into k1;
  insert into clients (company_id, name) values (c2, 'Cliente 2') returning id into k2;

  -- concluídos e recebidos, pelo fluxo real (RPC como a usuária)
  perform set_config('request.jwt.claim.sub', '$UID_A', true);
  for i in 1..11 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c1, k1, s1, m1, 100, now() - (i + 2) * interval '1 day', now() - (i + 2) * interval '1 day' + interval '1 hour') returning id into a;
    perform conclude_appointment(a, 100, 'pix');
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c2, k2, s2, m2, 150, now() - (i + 2) * interval '1 day', now() - (i + 2) * interval '1 day' + interval '1 hour') returning id into a;
    perform conclude_appointment(a, 150, 'dinheiro');
  end loop;

  -- o caso de R\$ 90: concluído pela RPC e recebimento apagado depois (Receitas > Excluir)
  insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values (c1, k1, s1, m1, 90, now() - interval '9 days 3 hours', now() - interval '9 days 2 hours', 'LEGADO-90') returning id into a;
  perform conclude_appointment(a, 90, 'pix');
  delete from payments where appointment_id = a;

  -- os 2 a regularizar: em aberto, terminaram antes de hoje
  insert into appointments (id, company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end, notes)
    values ('f077bf3d-5507-441a-8114-b3493ebd640b', c1, k1, s1, m1, 100, (hoje - 14 + time '17:00') at time zone 'America/Sao_Paulo',
            (hoje - 14 + time '18:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-100'),
           ('674b1ea5-3bbc-46dd-bd39-2799f0f51a35', c2, k2, s2, m2, 150, (hoje - 16 + time '08:00') at time zone 'America/Sao_Paulo',
            (hoje - 16 + time '09:00') at time zone 'America/Sao_Paulo', 'REGULARIZAR-150');

  -- cancelados/faltas e futuros
  for i in 1..5 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, status, scheduled_start, scheduled_end)
      values (c1, k1, s1, m1, 100, case when i % 2 = 0 then 'cancelado' else 'nao_compareceu' end::appointment_status,
              now() - (i + 20) * interval '1 day', now() - (i + 20) * interval '1 day' + interval '1 hour');
  end loop;
  for i in 1..6 loop
    insert into appointments (company_id, client_id, service_id, professional_member_id, price, scheduled_start, scheduled_end)
      values (c2, k2, s2, m2, 120, now() + i * interval '1 day', now() + i * interval '1 day' + interval '1 hour');
  end loop;
end \$\$;"
for m in 0014_appointment_lifecycle_guards 0015_auto_conclusion; do
  psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$m.sql" >/dev/null || { echo "FALHA: $m"; exit 1; }
done
# estado de produção: regularização feita e automação ativada
REG="$(Q "select aurea_private.regularize(array['f077bf3d-5507-441a-8114-b3493ebd640b','674b1ea5-3bbc-46dd-bd39-2799f0f51a35']::uuid[], 250, false) ->> 'run_id'")"
Q "select aurea_private.activate_auto_conclusion('$REG')" >/dev/null
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0017_whatsapp_core.sql" >/dev/null || { echo "FALHA: 0017"; exit 1; }
# fila da 0017 com um envio manual pendente (deve sobreviver intacto à 0018)
Q "insert into whatsapp_private.sessions (company_id, status) select id, 'disconnected' from companies where name = 'Studio 1';
   insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key)
   select c.company_id, 'send_text', c.id, '5511987654321', 'manual', 'manual-1' from clients c where c.name = 'Cliente 1'" >/dev/null
Q "alter default privileges grant execute on functions to anon, authenticated, service_role;
   alter default privileges grant all on tables to anon, authenticated, service_role;
   alter default privileges in schema whatsapp_private grant all on tables to anon, authenticated, service_role, wa_worker;
   alter default privileges grant all on sequences to anon, authenticated, service_role;" >/dev/null

OPS="$ROOT/operations/0018_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
DATA="select md5(string_agg(x, '|' order by x)) from (
  select 'a' || to_jsonb(t)::text x from appointments t union all select 'p' || to_jsonb(t)::text from payments t
  union all select 'c' || to_jsonb(t)::text from clients t union all select 'h' || to_jsonb(t)::text from appointment_status_history t
  union all select 'm' || to_jsonb(t)::text from company_members t union all select 'o' || to_jsonb(t)::text from companies t
  union all select 'l' || count(*)::text from audit_logs) z"
# definições EXISTENTES (exclui só os objetos novos da 0018: RPCs wa_* e o gatilho novo)
DEFS="select md5(string_agg(d, '|' order by d)) from (
  select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','aurea_private') and p.prokind in ('f','p') and p.proname not like 'wa\_%'
  union all select pg_get_triggerdef(t.oid) || t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','aurea_private') and not t.tgisinternal
   and t.tgname <> 'trg_appointments_wa_auto_confirmation'
  union all select pol.polname || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') from pg_policy pol
  union all select conname || pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace, 'aurea_private'::regnamespace)
  union all select grantee || privilege_type || table_schema || table_name from information_schema.role_table_grants
   where table_schema in ('public','aurea_private')) z"
# estado completo do WhatsApp (0017): funções, privilégios, colunas, tabelas
WDEFS="select md5(string_agg(d, '|' order by d)) from (
  select pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'whatsapp_private' or (n.nspname = 'public' and p.proname like 'wa\_%')
  union all select table_name || '.' || column_name || data_type || coalesce(column_default, '') from information_schema.columns where table_schema = 'whatsapp_private'
  union all select grantee || privilege_type || table_name from information_schema.role_table_grants where table_schema = 'whatsapp_private') z"
LEG="select md5(to_jsonb(a)::text) from appointments a where notes = 'LEGADO-90'"
AUTO="select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(s)::text x from aurea_private.settings s union all select to_jsonb(r)::text from aurea_private.runs r
  union all select to_jsonb(i)::text from aurea_private.run_items i) z"

[[ "$(B B0)" == "t|f|f|7|1" ]] && ok "B0 antes: $(B B0)" || ko "B0: $(B B0)"
F0="$(B B1)"; D0="$(Q "$DATA")"; DF0="$(Q "$DEFS")"; W0="$(Q "$WDEFS")"; L0="$(Q "$LEG")"; A0="$(Q "$AUTO")"
{ echo "begin;"; cat "$ROOT/migrations/0018_whatsapp_auto_confirmation.sql"; echo "commit;"; } > /tmp/proc18.sql
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/proc18.sql >/dev/null 2>&1 && ok "B2 0018 aplicada com begin/commit" || ko "B2"
[[ "$(B B3)" == "1|f|8|13|10|0|0" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(B B1)" == "$F0" ]] && ok "B1 foto igual depois da aplicação (dados, R\$ 90, automação, fila do WhatsApp)" || ko "B1 depois da aplicação"
[[ "$(Q "$DATA")" == "$D0" ]] && ok "M1 nenhum dado mudou (atendimentos, recebimentos, clientes, histórico, membros, empresas, auditoria)" || ko "M1"
[[ "$(Q "$DEFS")" == "$DF0" ]] && ok "M2 nenhuma função, gatilho, policy, constraint ou permissão existente mudou (0014/0015/0016 intactas)" || ko "M2"
[[ "$(Q "$LEG")" == "$L0" && "$(Q "$AUTO")" == "$A0" ]] && ok "M3 R\$ 90 idêntico; automação de conclusão intacta" || ko "M3"
[[ "$(Q "select not exists (select 1 from unnest(array['anon','authenticated','service_role','wa_worker']) rl
        where has_table_privilege(rl, 'whatsapp_private.appointment_confirmations', 'select,insert,update,delete'))
   and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','service_role']) rl
        where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute'))
   and not has_function_privilege('wa_worker', 'whatsapp_private.confirmation_text(uuid, timestamptz)', 'execute')
   and not has_function_privilege('anon', 'wa_get_appointment_confirmation(uuid)', 'execute')")" == t ]] \
  && ok "M4 privilégios no pior caso: tabela e funções novas não ficaram expostas" || ko "M4"
[[ "$(Q "select status from whatsapp_private.outbox where idempotency_key = 'manual-1'")" == pending ]] && ok "M5 envio pendente da 0017 intacto" || ko "M5"
[[ "$(Q "select aurea_private.run_auto_conclusion() ->> 'status'")" =~ ^(idle|ok)$ ]] && ok "M6 a automação de conclusão roda normalmente depois da 0018" || ko "M6"
D1="$(Q "$DATA")"; A1="$(Q "$AUTO")"
for t in 0014_appointment_lifecycle_staging 0015_auto_conclusion_staging 0017_whatsapp_core_staging; do
  out="$(psql -X -q -d "$DB" -f "$ROOT/tests/$t.sql" 2>&1)"
  nf=$(grep -a -c '^FAIL' <<<"$out"); np=$(grep -a -c '^PASS' <<<"$out")
  [[ "$nf" == 0 && "$np" -gt 0 ]] && ok "M7 $t neste banco: PASS=$np FAIL=0" || { ko "M7 $t PASS=$np FAIL=$nf"; grep -a '^FAIL' <<<"$out"; }
done
[[ "$(Q "$DATA")" == "$D1" && "$(Q "$AUTO")" == "$A1" ]] && ok "M8 depois das baterias, dados e automação continuam idênticos" || ko "M8"

# ligar / desligar
[[ "$(B B5)" == "t" ]] && ok "B5 ligar: chave global true" || ko "B5: $(B B5)"
B B6 >/dev/null; [[ "$(Q "select auto_confirmation_enabled from whatsapp_private.settings")" == f && "$(Q "select status from whatsapp_private.outbox where idempotency_key = 'manual-1'")" == pending ]] \
  && ok "B6 desligar: chave false; envio MANUAL pendente não é tocado" || ko "B6"
B B4 >/dev/null 2>&1 && ok "B4 consulta de acompanhamento roda" || ko "B4"

# reversão
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$WDEFS")" == "$W0" ]] && ok "BR WhatsApp voltou EXATAMENTE à 0017 (funções incl. claim_outbox, privilégios, colunas)" || ko "BR estado WhatsApp"
[[ "$(Q "$DEFS")" == "$DF0" && "$(Q "select count(*) from pg_trigger where tgname = 'trg_appointments_wa_auto_confirmation'")" == 0 ]] \
  && ok "BR gatilho removido; definições existentes iguais" || ko "BR definições"
[[ "$(B B0)" == "t|f|f|7|1" ]] && ok "BR [B0] igual ao de antes" || ko "BR B0: $(B B0)"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/proc18.sql >/dev/null 2>&1 && [[ "$(B B3)" == "1|f|8|13|10|0|0" ]] \
  && ok "BR reaplicar a 0018 depois da reversão funciona" || ko "BR reaplicação"

echo "RESULTADO roteiro 0018: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
