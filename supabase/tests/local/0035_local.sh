#!/usr/bin/env bash
# 0035 + 0036 — mensagens automáticas por data. SOMENTE LOCAL, com pg_cron real.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"; DB="aurea_cron"
export PGOPTIONS="-c client_min_messages=warning"
WITH_CRON=1 "$HERE/fresh_db.sh" "$DB" 0034 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
OPS="$ROOT/operations/0035_aplicacao_supabase.sql"; blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
errc() { local code="$1" name="$2"; shift 2; local out; out="$("$@" 2>&1)"; grep -q "ERROR:  $code" <<<"$out" && ok "$name" || ko "$name -> $(head -c 200 <<<"$out")"; }
STATE="select md5(string_agg(d, '|' order by d)) from (select n.nspname||p.proname||p.prosrc||coalesce(p.proacl::text,'') d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private')
  union all select table_schema||table_name||column_name from information_schema.columns where table_schema in ('public','whatsapp_private') union all select jobname||schedule from cron.job) z"
eval "$(Q "do \$\$ declare uo uuid; up uuid; a uuid; begin
  insert into auth.users (email) values ('own@q.local') returning id into uo; insert into auth.users (email) values ('pro@q.local') returning id into up;
  insert into companies (name) values ('Studio Bella') returning id into a;
  insert into company_members (company_id, user_id, role) values (a, uo, 'owner'), (a, up, 'professional');
end \$\$; select format('A=%s OWN=%s PRO=%s', (select id from companies where name='Studio Bella'), (select id from auth.users where email='own@q.local'), (select id from auth.users where email='pro@q.local'))")"
cli() { Q "insert into clients (company_id, name, phone, comm_status, first_visit_at) values ('$A', '$1', '$2', '$3', ${4:-null}) returning id"; }
K1="$(cli 'Ana Maria' 11987654321 allowed "date '2024-12-25'")"; K2="$(cli 'Bia Rocha' 11987650077 allowed)"
KU="$(cli 'Sem Autorização' 11987650011 unknown)"; KB="$(cli 'Pediu Sair' 11987650003 blocked)"
Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null
[[ "$(B B0)" == "t|f|0" ]] && ok "B0 antes: $(B B0)" || ko "B0 $(B B0)"; S0="$(Q "$STATE")"
for f in 0035_whatsapp_auto_messages.sql 0036_schedule_auto_messages.sql; do psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/$f" >/dev/null 2>&1 && ok "B2 $f" || ko "B2 $f"; done
[[ "$(B B3)" == "t|0|*/15 12-14 * * *|13|0" ]] && ok "B3 depois: $(B B3)" || ko "B3 $(B B3)"
check "C0 'cliente desde' preenchida com a primeira visita que já existia" "(select client_since = date '2024-12-25' from clients where id = '$K1')"
AT() { echo "(timestamp '$1' at time zone 'America/Sao_Paulo')"; }
run() { Q "select whatsapp_private.enqueue_auto_messages($(AT "$1"))"; }
st() { Q "select coalesce((select status || coalesce(':' || reason, '') from whatsapp_private.auto_message_log where client_id = '$1' and kind = '$2'), 'none')"; }
run '2026-12-25 09:05' >/dev/null
[[ "$(st "$K1" christmas)" == none ]] && ok "L1 nasce DESLIGADA: ninguém recebe" || ko "L1"
errc 42501 "L2 profissional NÃO liga" U "$PRO" "select wa_set_auto_message('$A', 'christmas', true, 'system', null)"
U "$OWN" "select wa_set_auto_message('$A', 'christmas', true, 'system', null)" >/dev/null
[[ "$(run '2026-12-25 08:59')" == *too_early* ]] && ok "L3 Natal às 8h59: ainda não" || ko "L3"
run '2026-12-24 10:00' >/dev/null
[[ "$(st "$K1" christmas)" == none ]] && ok "L4 dia 24: nada (só no dia 25)" || ko "L4"
run '2026-12-25 09:05' >/dev/null
[[ "$(st "$K1" christmas)" == queued && "$(st "$K2" christmas)" == queued ]] && ok "E1 Natal 9h05: clientes com autorização recebem" || ko "E1"
[[ "$(st "$KU" christmas)" == "skipped:consent_unknown" && "$(st "$KB" christmas)" == "skipped:blocked" ]] && ok "E2 sem autorização / pediu SAIR: não recebem (motivo registrado)" || ko "E2"
EXP="$(node -e 'const { load } = require("/home/claude/hive-beauty/tests/load-ts.cjs"); const m = load("/home/claude/hive-beauty/lib/hive/auto-messages.ts");
process.stdout.write(m.buildAutoMessage({ kind: "christmas", mode: "system", clientId: process.argv[1], year: 2026, name: "Ana Maria", business: "Studio Bella" }));' "$K1" | md5sum | cut -c1-32)"
[[ "$EXP" == "$(Q "select body from whatsapp_private.outbox where client_id = '$K1'" | tr -d '\n' | md5sum | cut -c1-32)" ]] && ok "E3 texto do banco = prévia da tela (paridade)" || ko "E3"
check "E4 envio espaçado como a Central (≥ 12 s entre as mensagens)" "(select max(available_at) - min(available_at) >= interval '12 seconds' from whatsapp_private.outbox where idempotency_key like 'auto:christmas:%')"
n0="$(Q "select count(*) from whatsapp_private.outbox")"; run '2026-12-25 11:30' >/dev/null
[[ "$(Q "select count(*) from whatsapp_private.outbox")" == "$n0" ]] && ok "E5 rodadas seguintes não duplicam" || ko "E5"
r="$(Q "select whatsapp_private.enqueue_send('$A', '$K2', null, '5511987650077', 'Confirmação de teste', 'conf-teste-1')")"
[[ "$r" == *'"created": true'* ]] && ok "E6 confirmação de agendamento continua saindo na hora durante o envio do Natal" || ko "E6 $r"
# aniversário de cliente
Q "update clients set client_since = date '2024-03-10' where id = '$K2'; update clients set client_since = date '2026-09-10' where id = '$KU';
   update clients set comm_status = 'allowed' where id = '$KU'" >/dev/null
errc AUT01 "P1 Natal não aceita {anos}" U "$OWN" "select wa_set_auto_message('$A', 'christmas', true, 'custom', 'Faz {anos}')"
U "$OWN" "select wa_set_auto_message('$A', 'client_anniversary', true, 'custom', 'Parabéns, {nome}! Hoje faz {anos} juntas.')" >/dev/null
run '2026-03-10 09:20' >/dev/null
check "A1 aniversário de cliente: 'Parabéns, Bia! Hoje faz 2 anos juntas.'" "(select body = 'Parabéns, Bia! Hoje faz 2 anos juntas.' from whatsapp_private.outbox o join whatsapp_private.auto_message_log l on l.outbox_id = o.id where l.client_id = '$K2' and l.kind = 'client_anniversary')"
run '2027-03-10 09:20' >/dev/null
[[ "$(st "$KU" client_anniversary)" == none ]] && ok "A2 menos de 1 ano de cliente: ainda não" || ko "A2"
KL="$(cli 'Leap' 11987650029 allowed)"; Q "update clients set client_since = date '2024-02-29' where id = '$KL'" >/dev/null
run '2027-02-28 09:20' >/dev/null
[[ "$(st "$KL" client_anniversary)" == queued ]] && ok "A3 cliente desde 29/02: em ano comum recebe em 28/02" || ko "A3"
errc 42501 "X1 authenticated não lê o registro" U "$OWN" "select count(*) from whatsapp_private.auto_message_log"
errc 42501 "X2 authenticated não dispara" U "$OWN" "select whatsapp_private.enqueue_auto_messages()"
[[ "$(U "$PRO" "select wa_get_auto_messages('$A') -> 'items' -> 'christmas' ->> 'enabled'")" == true ]] && ok "X3 equipe vê a configuração" || ko "X3"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$STATE")" == "$S0" ]] && ok "BR voltou EXATAMENTE ao estado da 0034" || ko "BR estado"
echo "RESULTADO 0035/0036: PASS=$pass FAIL=$fail"; dropdb --force "$DB"; [[ $fail -eq 0 ]]
