#!/usr/bin/env bash
# Testa a função mp-sync sem rede. Uso: bash supabase/tests/local/mp-sync/run.sh
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$H/../../.." && pwd)"; T="$(mktemp -d)"
sed 's#https://esm.sh/@supabase/supabase-js@2.45.4#./stub.ts#' "$R/functions/mp-sync/index.ts" > "$T/index.ts"
cp "$H/stub.ts" "$H/test.ts" "$T/"
(cd "$T" && deno check index.ts >/dev/null && deno run --allow-env test.ts)
# as funções de cobrança têm de ser IGUAIS às da mp-webhook
diff <(awk '/^export function paymentRecord/,/^}/' "$R/functions/mp-webhook/index.ts") <(awk '/^export function paymentRecord/,/^}/' "$R/functions/mp-sync/index.ts") >/dev/null && echo "PASS paymentRecord idêntica à mp-webhook" || echo "FAIL paymentRecord difere da mp-webhook"
rm -rf "$T"
