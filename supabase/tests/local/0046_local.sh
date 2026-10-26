#!/usr/bin/env bash
# 0046 — e-mail da conta já ligada à assinatura (mp-sync). SOMENTE LOCAL.
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0046; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0045 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
AN() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role anon; $1; commit;" 2>&1; }
AU() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role authenticated; $1; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0046_mp_sync_known_emails.sql >/dev/null 2>/tmp/0046.err && ok "0046 aplicada" || ko "0046: $(cat /tmp/0046.err)"
has "$(AN "select * from mp_sync_known_emails(array['P'])")" "permission denied" && has "$(AU "select * from mp_sync_known_emails(array['P'])")" "permission denied" && ok "só o servidor" || ko "aberta"
Q "insert into billing_accounts (email, status, provider, preapproval_id) values ('tai@x.com','trialing','mercadopago','P1')" >/dev/null
Q "insert into billing_subscription_events (email, preapproval_id, status, mp_status, source, occurred_at) values ('so-historico@x.com','P2','canceled','cancelled','webhook', now() - interval '3 days')" >/dev/null 2>&1
R1="$(SR "select string_agg(preapproval_id||'='||email, ',' order by preapproval_id) from mp_sync_known_emails(array['P1','P2','P3'])")"
has "$R1" "P1=tai@x.com" && ok "assinatura ligada a uma conta: devolve o e-mail da conta" || ko "conta: $R1"
has "$R1" "P2=so-historico@x.com" && ok "sem conta, mas no histórico: devolve o e-mail do histórico" || ko "histórico: $R1"
! has "$R1" "P3" && ok "assinatura desconhecida: nada (segue para a busca)" || ko "P3: $R1"
Q "insert into billing_subscription_events (email, preapproval_id, status, mp_status, source, occurred_at) values ('outro@x.com','P1','trialing','authorized','webhook', now())" >/dev/null 2>&1
[[ "$(SR "select email from mp_sync_known_emails(array['P1'])")" == "tai@x.com" ]] && ok "conta tem prioridade sobre o histórico" || ko "prioridade"
echo "RESULTADO 0046: PASS=$pass FAIL=$fail"; dropdb --force $DB
