#!/usr/bin/env bash
# Testa a função admin-billing sem rede (stub do supabase-js + Mercado Pago simulado).
# Uso: bash supabase/tests/local/admin-billing/run.sh
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$H/../../.." && pwd)"; T="$(mktemp -d)"
sed 's#https://esm.sh/@supabase/supabase-js@2.45.4#./stub.ts#' "$R/functions/admin-billing/index.ts" > "$T/admin.ts"
sed 's#https://esm.sh/@supabase/supabase-js@2.45.4#./stub.ts#' "$R/functions/mp-webhook/index.ts" > "$T/hook.ts"
cp "$H/stub.ts" "$H/test.ts" "$T/"
(cd "$T" && deno check admin.ts >/dev/null && deno run --allow-env --allow-net test.ts)
rm -rf "$T"
