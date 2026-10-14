#!/usr/bin/env bash
# Roda TODOS os testes de banco LOCALMENTE (Postgres local, nunca o Supabase):
#   1. banco do zero com 0001–ÚLTIMA migration;
#   2. testes SQL de staging (0009, 0010, 0012, 0014) — cada um desfaz seus dados;
#   3. concorrência/COMMIT real (0014) e preservação de dados na migration (0014).
# Uso (como usuário do Postgres local): supabase/tests/local/run_all_local.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TESTS="$(cd "$HERE/.." && pwd)"
DB="aurea_tests_local"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
total_fail=0
for t in "$TESTS"/0*_staging.sql "$TESTS"/0*_producao_*.sql; do
  out="$(psql -X -q -d "$DB" -f "$t" 2>&1)"
  pass=$(grep -a -c '^PASS' <<<"$out"); fail=$(grep -a -c '^FAIL' <<<"$out"); info=$(grep -a -c '^INFO' <<<"$out")
  printf '%-48s PASS=%-3s FAIL=%-3s INFO=%s\n' "$(basename "$t")" "$pass" "$fail" "$info"
  grep -a '^FAIL' <<<"$out" | sed 's/^/    /'
  total_fail=$((total_fail + fail))
done
dropdb --force "$DB"
for s in "$HERE"/0*_local.sh; do
  out="$("$s" 2>&1)"; rc=$?
  echo "$(basename "$s"): $(grep -a '^RESULTADO' <<<"$out")"
  grep -a '^FAIL' <<<"$out" | sed 's/^/    /'
  [[ $rc -ne 0 ]] && total_fail=$((total_fail + 1))
done
echo "TOTAL DE FALHAS: $total_fail"
[[ $total_fail -eq 0 ]]
