#!/usr/bin/env bash
# ============================================================================
# 0015 — auditoria de privilégios no PIOR CASO. SOMENTE LOCAL.
# Antes de aplicar a 0015, o banco recebe privilégios padrão agressivos
# (toda função/tabela nova seria liberada para anon/authenticated/service_role
# em QUALQUER schema). A 0015 precisa neutralizar isso sozinha.
# Também confirma que o dono executa a automação internamente.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_priv_0015"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0014 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -d "$DB" -c "$1"; }
Q "alter default privileges grant execute on functions to anon, authenticated, service_role;
   alter default privileges grant all on tables to anon, authenticated, service_role;
   alter default privileges grant all on sequences to anon, authenticated, service_role;" >/dev/null
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0015_auto_conclusion.sql" >/dev/null || { echo "FALHA: 0015 não aplicou"; exit 1; }

pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }

echo "--- auditoria (diagnostics/0015_privileges_audit.sql, seções 1 e 2):"
psql -X -q -d "$DB" -c "$(sed -n '/SEÇÃO 1/,/order by 1;/p' "$ROOT/diagnostics/0015_privileges_audit.sql")" | sed 's/^/   /'
SUM="$(psql -X -q -A -F'|' -t -d "$DB" -c "$(sed -n '/SEÇÃO 2/,/schemas_expostos_postgrest_se_disponivel;/p' "$ROOT/diagnostics/0015_privileges_audit.sql")")"
echo "   resumo (funcoes|tabelas|sem_rls|papeis_schema|acessos_tabelas|funcoes_expostas|pgrst): $SUM"
IFS='|' read -r nf nt nsr nps nat nfe _ <<<"$SUM"
[[ "$nf" -ge 10 && "$nt" == 4 && "$nsr" == 0 && "$nps" == 0 && "$nat" == 0 && "$nfe" == 0 ]] \
  && ok "P1 pior caso neutralizado: 0 funções expostas, 0 acesso a schema/tabelas, RLS em todas" || ko "P1 resumo: $SUM"

for rl in anon authenticated service_role; do
  out="$(psql -X -q -d "$DB" -c "set role $rl; select aurea_private.run_auto_conclusion();" 2>&1)"
  grep -q "permission denied for schema aurea_private" <<<"$out" && ok "P2 $rl NÃO executa run_auto_conclusion" || ko "P2 $rl: $out"
  out="$(psql -X -q -d "$DB" -c "set role $rl; select * from aurea_private.settings;" 2>&1)"
  grep -q "permission denied for schema aurea_private" <<<"$out" && ok "P3 $rl NÃO lê a configuração" || ko "P3 $rl: $out"
done
# Mesmo se alguém conceder USAGE no schema por engano, as funções continuam negadas
out="$(psql -X -q -d "$DB" -c "begin; grant usage on schema aurea_private to authenticated; set local role authenticated; select aurea_private._run(now(), null, null, true); rollback;" 2>&1)"
grep -q "permission denied for function _run" <<<"$out" && ok "P4 com USAGE concedido por engano, _run continua negada (sem EXECUTE)" || ko "P4: $out"

out="$(Q "select aurea_private.run_auto_conclusion()")"
[[ "$out" == '{"status": "disabled"}' ]] && ok "P5 o dono (postgres) executa a automação internamente (desligada: 'disabled')" || ko "P5: $out"
[[ "$(Q "select pg_get_userbyid(proowner) from pg_proc where proname = 'run_auto_conclusion'")" == "postgres" ]] \
  && ok "P6 dono das funções privadas = postgres (o mesmo papel que agenda o cron)" || ko "P6"

echo "RESULTADO privilégios 0015: PASS=$pass FAIL=$fail"
dropdb "$DB"
[[ $fail -eq 0 ]]
