#!/usr/bin/env bash
# Testa a função mp-webhook sem rede: troca o supabase-js por um stub e simula
# o Mercado Pago e a assinatura HMAC. Uso: bash supabase/tests/local/mp-webhook/run.sh
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$H/../../.." && pwd)"; T="$(mktemp -d)"
sed 's#https://esm.sh/@supabase/supabase-js@2.45.4#./stub.ts#' "$R/functions/mp-webhook/index.ts" > "$T/index.ts"
cp "$H/stub.ts" "$H/test.ts" "$T/"
(cd "$T" && deno check index.ts >/dev/null && deno run --allow-env --allow-net test.ts)
rm -rf "$T"
