#!/usr/bin/env bash
# ============================================================================
# 0018 — paridade do texto da confirmação: banco (SQL) x tela (TypeScript).
# SOMENTE LOCAL. Banco do zero com todas as migrations; nada persiste.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="aurea_parity_0018"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
node "$HERE/0018_message_parity.cjs" "$DB"; rc=$?
dropdb --force "$DB"
exit $rc
