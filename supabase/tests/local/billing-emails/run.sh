#!/usr/bin/env bash
# Testa a função billing-emails sem rede. Uso: bash supabase/tests/local/billing-emails/run.sh
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$H/../../.." && pwd)"; T="$(mktemp -d)"
sed 's#https://esm.sh/@supabase/supabase-js@2.45.4#./stub.ts#' "$R/functions/billing-emails/index.ts" > "$T/index.ts"
cp "$H/stub.ts" "$H/test.ts" "$T/"
(cd "$T" && deno check index.ts >/dev/null && TZ=UTC deno run --allow-env test.ts)
rm -rf "$T"
