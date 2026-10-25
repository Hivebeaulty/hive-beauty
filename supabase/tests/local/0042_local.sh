#!/usr/bin/env bash
# ============================================================================
# 0042 — e-mails da assinatura. SOMENTE LOCAL (banco descartável).
# Listas (boas-vindas e aviso antes da cobrança), janela de horário, reserva sem
# duplicidade, novas tentativas após erro (até 5) e permissões.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0042; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0041 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
AU() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role authenticated; $1; commit;" 2>&1; }
AN() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role anon; $1; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0042_billing_emails.sql >/dev/null 2>/tmp/0042.err && ok "0042 aplicada (sem pg_net/Vault locais: agendamento ignorado)" || ko "0042: $(cat /tmp/0042.err)"

for f in "billing_email_targets()" "billing_email_claim('welcome','P','a@x.com')" "billing_email_finish(1,true,null,null)" "billing_emails_secret_ok('x')"; do
  has "$(AN "select $f")" "permission denied" && has "$(AU "select $f")" "permission denied" && ok "só o servidor chama ${f%%(*}" || ko "aberto: $f"
done
has "$(AU "select count(*) from billing_emails")" "permission denied" && ok "registro de e-mails invisível pela API" || ko "tabela exposta"
[[ "$(SR "select billing_emails_secret_ok('curto')")" == f ]] && ok "segredo curto recusado" || ko "segredo"

# cenário: horário fixo de referência = 2026-11-10 12:00 (Brasília) = 15:00 UTC
NOW="timestamptz '2026-11-10 15:00:00+00'"
Q "insert into billing_accounts (email, status, provider, preapproval_id, started_at, next_payment_at, plan_amount, updated_at) values
  ('novo@x.com','trialing','mercadopago','P1', $NOW - interval '1 hour', $NOW + interval '6 days', 59.90, $NOW),
  ('dia5@x.com','trialing','mercadopago','P2', $NOW - interval '5 days', $NOW + interval '40 hours', 59.90, $NOW - interval '5 days'),
  ('cedo@x.com','trialing','mercadopago','P3', $NOW - interval '3 days', $NOW + interval '4 days', 59.90, $NOW - interval '3 days'),
  ('tarde@x.com','trialing','mercadopago','P4', $NOW - interval '7 days', $NOW + interval '6 hours', 59.90, $NOW - interval '7 days'),
  ('antiga@x.com','active','mercadopago','P5', $NOW - interval '40 days', $NOW + interval '20 days', 59.90, $NOW - interval '40 days'),
  ('cortesia@x.com','free','manual',null, null, null, null, $NOW),
  ('cancelada@x.com','canceled','mercadopago','P7', $NOW - interval '2 days', null, 59.90, $NOW)" >/dev/null
T="$(SR "select billing_email_targets($NOW)::text")"
W="$(SR "select string_agg(x->>'email', ',' order by x->>'email') from jsonb_array_elements(billing_email_targets($NOW)->'welcome') x")"
E="$(SR "select string_agg(x->>'email', ',' order by x->>'email') from jsonb_array_elements(billing_email_targets($NOW)->'trial_ending') x")"
[[ "$W" == "dia5@x.com,cedo@x.com,novo@x.com" || "$W" == "cedo@x.com,dia5@x.com,novo@x.com" ]] && ok "boas-vindas: só assinaturas recentes do Mercado Pago (sem antiga, cortesia, cancelada)" || ko "welcome: $W"
[[ "$E" == "dia5@x.com" ]] && ok "aviso: só quem está a ~2 dias da cobrança (nem cedo, nem em cima da hora)" || ko "trial_ending: $E"
has "$T" '"amount": 59.90' && ok "valor da assinatura vai junto" || ko "amount"
N3="timestamptz '2026-11-10 06:00:00+00'"   # 03h em Brasília
[[ "$(SR "select jsonb_array_length(billing_email_targets($N3)->'trial_ending')")" == 0 ]] && ok "aviso não sai de madrugada (03h)" || ko "madrugada"
[[ "$(SR "select jsonb_array_length(billing_email_targets($N3)->'welcome')")" -ge 1 ]] && ok "boas-vindas sai a qualquer hora" || ko "welcome madrugada"

# reserva sem duplicidade
ID=$(SR "select billing_email_claim('welcome','P1','NOVO@x.com')")
[[ -n "$ID" ]] && ok "primeira reserva: id $ID" || ko "claim"
[[ -z "$(SR "select billing_email_claim('welcome','P1','novo@x.com')")" ]] && ok "segunda reserva do mesmo e-mail: recusada (sem duplicidade)" || ko "duplicou"
[[ "$(Q "select email from billing_emails where id=$ID")" == "novo@x.com" ]] && ok "e-mail guardado em minúsculas" || ko "lower"
[[ "$(SR "select jsonb_array_length(billing_email_targets(now())->'welcome')")" == "$(SR "select jsonb_array_length(billing_email_targets(now())->'welcome')")" ]] && true
SR "select billing_email_finish($ID, true, 'msg-1', null)" >/dev/null
[[ "$(Q "select status||' '||provider_message_id from billing_emails where id=$ID")" == "sent msg-1" ]] && ok "envio registrado como enviado" || ko "finish ok"
[[ -z "$(SR "select billing_email_claim('welcome','P1','novo@x.com')")" ]] && ok "depois de enviado, nunca mais reserva" || ko "reenvio"
W2="$(SR "select string_agg(x->>'email', ',') from jsonb_array_elements(billing_email_targets($NOW)->'welcome') x")"
! has "$W2" "novo@x.com" && ok "enviado some da lista" || ko "lista após envio: $W2"

# erro do provedor: tenta de novo até 5 vezes
ID2=$(SR "select billing_email_claim('trial_ending','P2','dia5@x.com')"); SR "select billing_email_finish($ID2, false, null, 'Brevo 503')" >/dev/null
[[ "$(Q "select status||' '||error from billing_emails where id=$ID2")" == "error Brevo 503" ]] && ok "erro registrado" || ko "erro"
has "$(SR "select billing_email_targets($NOW)->'trial_ending'")" "dia5@x.com" && ok "com erro, volta para a lista" || ko "não voltou"
for i in 2 3 4 5; do R2=$(SR "select billing_email_claim('trial_ending','P2','dia5@x.com')"); SR "select billing_email_finish($R2, false, null, 'falha $i')" >/dev/null; done
[[ "$(Q "select attempts from billing_emails where id=$ID2")" == 5 ]] && ok "5 tentativas" || ko "tentativas: $(Q "select attempts from billing_emails where id=$ID2")"
[[ -z "$(SR "select billing_email_claim('trial_ending','P2','dia5@x.com')")" ]] && ok "depois de 5 erros, para de tentar" || ko "sexta tentativa"
! has "$(SR "select billing_email_targets($NOW)->'trial_ending'")" "dia5@x.com" && ok "e sai da lista" || ko "lista após 5"
# reserva presa em 'sending' há mais de 30 min pode ser retomada
ID3=$(SR "select billing_email_claim('welcome','P3','cedo@x.com')"); Q "update billing_emails set updated_at = now() - interval '31 minutes' where id=$ID3" >/dev/null
[[ -n "$(SR "select billing_email_claim('welcome','P3','cedo@x.com')")" ]] && ok "envio travado (>30 min) é retomado" || ko "travado"
has "$(SR "select billing_email_claim('outro','P3','cedo@x.com')")" "Envio inválido" && ok "tipo desconhecido recusado" || ko "tipo"
has "$(SR "select billing_email_claim('welcome','P3','sem-arroba')")" "Envio inválido" && ok "e-mail inválido recusado" || ko "email"

echo "RESULTADO 0042: PASS=$pass FAIL=$fail"; dropdb --force $DB
