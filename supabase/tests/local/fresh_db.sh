#!/usr/bin/env bash
# Cria um banco Postgres LOCAL do zero (simulação mínima do Supabase + migrations).
# Uso: supabase/tests/local/fresh_db.sh <nome_do_banco> [ultima_migration, ex.: 0013]
# Padrão: todas as migrations, EXCETO a 0016 (pg_cron), que só entra com
# WITH_CRON=1 e exige o Postgres local com pg_cron pré-carregado.
# NUNCA aponte para o Supabase: usa o Postgres local via usuário "postgres".
set -euo pipefail
DB="${1:?informe o nome do banco local}"
LAST="${2:-9999}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
dropdb --if-exists --force "$DB" 2>/dev/null
createdb "$DB"
"${PSQL[@]}" -d "$DB" -f "$HERE/supabase_shim.sql"
for f in "$ROOT"/migrations/0*.sql; do
  n="$(basename "$f" | cut -c1-4)"
  [[ "$n" > "$LAST" ]] && break
  # as migrations de agendamento (0016, 0021: pg_cron) só entram com WITH_CRON=1
  [[ "$f" == *_schedule_* && "${WITH_CRON:-0}" != 1 ]] && continue
  "${PSQL[@]}" -1 -d "$DB" -f "$f"
  echo "aplicada: $(basename "$f")"
done
"${PSQL[@]}" -d "$DB" -c "insert into auth.users (email, raw_user_meta_data) values
  ('a@teste.local', '{\"full_name\":\"Usuaria A\"}'), ('b@teste.local', '{\"full_name\":\"Usuaria B\"}')"
