#!/usr/bin/env bash
# ============================================================================
# Ensaio LOCAL do roteiro 0020 + 0021 (com pg_cron real), privilégios no pior
# caso. Prova: só objetos do lembrete mudam; nada é enviado; reversão volta
# EXATAMENTE ao estado anterior (0019). Precisa do banco 'aurea_cron' (pg_cron).
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_cron"
export PGOPTIONS="-c client_min_messages=warning"
WITH_CRON=1 "$HERE/fresh_db.sh" "$DB" 0019 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
OPS="$ROOT/operations/0020_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
Q "alter default privileges grant execute on functions to anon, authenticated, service_role;
   alter default privileges grant all on tables to anon, authenticated, service_role;
   alter default privileges in schema whatsapp_private grant all on tables to anon, authenticated, service_role, wa_worker;
   alter default privileges in schema whatsapp_private grant execute on functions to anon, authenticated, service_role, wa_worker;" >/dev/null
STATE="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || pg_get_function_identity_arguments(p.oid) || p.prosrc || coalesce(p.proacl::text,'') d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private')
  union all select pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
  union all select table_schema || '.' || table_name || '.' || column_name || data_type || coalesce(column_default,'') from information_schema.columns where table_schema in ('public','whatsapp_private','aurea_private')
  union all select grantee || privilege_type || table_schema || table_name from information_schema.role_table_grants where table_schema in ('public','whatsapp_private')
  union all select jobname || schedule || command from cron.job) z"
OTHER="select md5(string_agg(d, '|' order by d)) from (
  select n.nspname || '.' || p.proname || pg_get_function_identity_arguments(p.oid) || p.prosrc || coalesce(p.proacl::text,'') d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','whatsapp_private','aurea_private')
     and p.proname not in ('claim_outbox','reminder_text','enqueue_day_before_reminders')
  union all select pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
  union all select grantee || privilege_type || table_schema || table_name from information_schema.role_table_grants
   where table_schema in ('public','whatsapp_private') and table_name <> 'appointment_reminders'
  union all select jobname || schedule || command from cron.job where jobname <> 'aurea-wa-day-before-reminder') z"
[[ "$(B B0)" == "t|f|0|t" ]] && ok "B0 antes: $(B B0)" || ko "B0: $(B B0)"
S0="$(Q "$STATE")"; O0="$(Q "$OTHER")"
for f in 0020_whatsapp_day_before_reminder.sql 0021_schedule_day_before_reminder.sql; do
  psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$f" >/dev/null 2>&1 && ok "B2 $f aplicada" || ko "B2 $f"
done
[[ "$(B B3)" == "t|f|1|*/15 21-23 * * *|13|0" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$OTHER")" == "$O0" ]] && ok "M1 nada fora do lembrete mudou (funções, gatilhos, permissões, job da 0016)" || ko "M1"
[[ "$(Q "select command from cron.job where jobname = 'aurea-wa-day-before-reminder'")" == "select whatsapp_private.enqueue_day_before_reminders()" ]] \
  && ok "M2 o job chama só o disparo do lembrete" || ko "M2"
[[ "$(Q "select whatsapp_private.enqueue_day_before_reminders() ->> 'status'")" == disabled ]] && ok "M3 o que o job executa: desligado, não faz nada" || ko "M3"
[[ "$(Q "select count(*) from whatsapp_private.outbox")" == 0 ]] && ok "M4 nada foi enfileirado" || ko "M4"
for f in 0020_whatsapp_day_before_reminder.sql 0021_schedule_day_before_reminder.sql; do psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$f" >/dev/null 2>&1; done
[[ "$(Q "select count(*) from cron.job where jobname = 'aurea-wa-day-before-reminder'")" == 1 ]] && ok "M5 reaplicar não duplica o job" || ko "M5"
[[ "$(B B5)" == "t" ]] && ok "B5 ligar" || ko "B5"
B B6 >/dev/null; [[ "$(Q "select reminder_enabled from whatsapp_private.settings")" == f ]] && ok "B6 desligar" || ko "B6"
B B4 >/dev/null 2>&1 && ok "B4 acompanhamento roda" || ko "B4"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$STATE")" == "$S0" ]] && ok "BR voltou EXATAMENTE ao estado da 0019 (funções, claim_outbox, colunas, permissões, jobs)" || ko "BR estado"
[[ "$(B B0)" == "t|f|0|t" ]] && ok "BR [B0] igual ao de antes" || ko "BR B0: $(B B0)"
echo "RESULTADO roteiro 0020: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
