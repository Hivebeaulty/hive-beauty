#!/usr/bin/env bash
# ============================================================================
# 0017 — privilégios no PIOR CASO. SOMENTE LOCAL.
# Antes da 0017, o banco recebe privilégios padrão agressivos (toda função e
# tabela nova liberadas para anon/authenticated/service_role). A 0017 precisa
# neutralizar sozinha. Também tenta login real com wa_worker (deve falhar).
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_priv_0017"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0015 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -d "$DB" -c "$1"; }
Q "alter default privileges grant execute on functions to anon, authenticated, service_role;
   alter default privileges grant all on tables to anon, authenticated, service_role;
   alter default privileges grant all on sequences to anon, authenticated, service_role;" >/dev/null
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0017_whatsapp_core.sql" >/dev/null || { echo "FAIL: 0017 não aplicou"; exit 1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }

check "P1 nenhuma tabela/sequência privada acessível por anon/authenticated/service_role" \
  "not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               cross join unnest(array['anon','authenticated','service_role']) rl
               where n.nspname = 'whatsapp_private' and c.relkind in ('r','S')
                 and has_table_privilege(rl, c.oid, 'select,insert,update,delete'))"
check "P2 nenhuma função privada executável pela API ou por PUBLIC" \
  "not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               cross join unnest(array['anon','authenticated','service_role']) rl
               where n.nspname = 'whatsapp_private' and has_function_privilege(rl, p.oid, 'execute'))
   and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                   aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
                   where n.nspname = 'whatsapp_private' and e.grantee = 0 and e.privilege_type = 'EXECUTE')"
check "P3 RPCs do app: só authenticated (anon e service_role sem acesso)" \
  "(select bool_and(has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('service_role', p.oid, 'execute'))
    from pg_proc p where p.proname in ('wa_get_status','wa_request_connection','wa_get_qr','wa_disconnect',
                                       'wa_send_message','wa_send_confirmation','wa_get_conversation'))"
check "P4 wa_worker sem acesso a tabelas (mesmo com privilégios padrão agressivos)" \
  "not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname in ('whatsapp_private','public') and c.relkind = 'r'
                 and has_table_privilege('wa_worker', c.oid, 'select,insert,update,delete'))"
for rl in anon authenticated service_role; do
  out="$(psql -X -q -d "$DB" -c "set role $rl; select * from whatsapp_private.claim_outbox('x', 1, 60);" 2>&1)"
  grep -q "permission denied for schema whatsapp_private" <<<"$out" && ok "P5 $rl NÃO chama a fila do worker" || ko "P5 $rl: $out"
done
check "P6 wa_worker sem login e sem senha (nenhuma credencial existe nesta etapa)" \
  "(select not rolcanlogin and rolpassword is null from pg_authid where rolname = 'wa_worker')"
check "P7 dono de todas as funções novas = postgres" \
  "(select bool_and(pg_get_userbyid(p.proowner) = 'postgres') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'whatsapp_private' or p.proname like 'wa\\_%')"

echo "RESULTADO privilégios 0017: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
