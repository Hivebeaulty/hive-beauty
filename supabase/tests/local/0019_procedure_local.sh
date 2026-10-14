#!/usr/bin/env bash
# ============================================================================
# Ensaio LOCAL da 0019: aplicar sobre a 0018 com privilégios no pior caso,
# provar que SÓ a função do texto muda, e que a reversão volta EXATAMENTE à 0018.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_proc_0019"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0018 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
OPS="$ROOT/operations/0019_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
Q "alter default privileges grant execute on functions to anon, authenticated, service_role;
   alter default privileges in schema whatsapp_private grant execute on functions to anon, authenticated, service_role, wa_worker;" >/dev/null
# tudo, menos a função do texto
REST="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || pg_get_function_identity_arguments(p.oid) || p.prosrc || coalesce(p.proacl::text,'') d
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','whatsapp_private','aurea_private') and not (n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text')
  union all select pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
  union all select table_schema || table_name || column_name || data_type from information_schema.columns where table_schema in ('public','whatsapp_private')) z"
TXT="select md5(p.prosrc || coalesce(p.proacl::text,'') || coalesce(array_to_string(p.proconfig, ','),'') || p.prosecdef::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private' and p.proname = 'confirmation_text'"
[[ "$(B B0)" == "t|f" ]] && ok "B0 antes: $(B B0)" || ko "B0: $(B B0)"
R0="$(Q "$REST")"; T0="$(Q "$TXT")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0019_whatsapp_message_variants.sql" >/dev/null 2>&1 && ok "B2 0019 aplicada" || ko "B2"
[[ "$(B B3)" == "t|0|13|0" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$REST")" == "$R0" ]] && ok "M1 nada além da função do texto mudou (funções, permissões, gatilhos, colunas)" || ko "M1"
[[ "$(Q "$TXT")" != "$T0" ]] && ok "M2 a função do texto foi trocada" || ko "M2"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0019_whatsapp_message_variants.sql" >/dev/null 2>&1 && ok "M3 a 0019 pode ser reaplicada" || ko "M3"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$TXT")" == "$T0" && "$(Q "$REST")" == "$R0" ]] && ok "BR voltou EXATAMENTE ao texto da 0018, com as mesmas permissões" || ko "BR estado"
[[ "$(B B0)" == "t|f" ]] && ok "BR [B0] igual ao de antes" || ko "BR B0: $(B B0)"
echo "RESULTADO roteiro 0019: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
