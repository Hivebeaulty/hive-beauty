#!/usr/bin/env bash
# ============================================================================
# Integração do worker com um Postgres LOCAL (nunca o Supabase).
# Monta um banco do zero (0001–0017), dá ao papel wa_worker uma senha de TESTE
# aleatória (só neste Postgres local), roda os testes e desfaz tudo no fim.
# Uso (root, com o Postgres local no ar): whatsapp-worker/test/integration/run-local.sh
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORKER="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$WORKER/.." && pwd)"
DB="aurea_wa_it"
PW_WORKER="$(openssl rand -hex 16)"
PW_ADMIN="$(openssl rand -hex 16)"
SUPW() { su postgres -c "psql -X -q -v ON_ERROR_STOP=1 -d $1 -c \"$2\""; }

su postgres -c "PGOPTIONS='-c client_min_messages=warning' $REPO/supabase/tests/local/fresh_db.sh $DB" >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
SUPW postgres "alter role wa_worker login password '$PW_WORKER'" >/dev/null
SUPW postgres "drop role if exists wa_it_admin; create role wa_it_admin login superuser password '$PW_ADMIN'" >/dev/null

cleanup() {
  SUPW postgres "alter role wa_worker nologin password null" >/dev/null 2>&1
  su postgres -c "dropdb --force --if-exists $DB" >/dev/null 2>&1
  SUPW postgres "drop role if exists wa_it_admin" >/dev/null 2>&1
}
trap cleanup EXIT

cd "$WORKER"
export WA_IT_WORKER_URL="postgres://wa_worker:$PW_WORKER@127.0.0.1:5432/$DB"
export WA_IT_ADMIN_URL="postgres://wa_it_admin:$PW_ADMIN@127.0.0.1:5432/$DB"
export NODE_ENV=test
timeout 240 node --test --test-concurrency=1 --test-timeout=60000 ${WA_IT_FILES:-"test/integration/*.test.js"}
