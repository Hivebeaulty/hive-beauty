#!/usr/bin/env bash
# ============================================================================
# 0039 — histórico de assinaturas e pagamentos. SOMENTE LOCAL (banco descartável).
# Aviso repetido não duplica; aviso fora de ordem não volta a situação; cortesia
# nunca é rebaixada; reembolso não "desfaz"; ninguém lê/escreve pela API.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0039; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0038 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
AU() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role authenticated; $1; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

Q "insert into billing_accounts (email, status, provider) values ('cortesia@x.com', 'free', 'cortesia')" >/dev/null
BEFORE="$(Q "select string_agg(email||'='||status||'/'||provider, ',') from billing_accounts")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0039_billing_history.sql >/dev/null 2>/tmp/0039.err && ok "0039 aplicada" || ko "0039: $(cat /tmp/0039.err)"
[[ "$(Q "select string_agg(email||'='||status||'/'||provider, ',') from billing_accounts")" == "$BEFORE" ]] && ok "contas existentes intactas" || ko "contas mudaram"

# --- permissões ----------------------------------------------------------------------
for f in "billing_sync('{}')" "billing_record_payment('{}')"; do
  has "$(AU "select $f")" "permission denied" && ok "usuária logada não chama ${f%%(*}" || ko "exposto: $f"
done
has "$(AU "select count(*) from billing_payments")" "permission denied" && ok "pagamentos não são legíveis pela API" || ko "pagamentos expostos"
has "$(AU "select count(*) from billing_subscription_events")" "permission denied" && ok "histórico não é legível pela API" || ko "histórico exposto"

T0="2026-10-20T12:00:00Z"
sync() { SR "select billing_sync('{\"email\":\"$1\",\"status\":\"$2\",\"preapproval_id\":\"$3\",\"mp_status\":\"$4\",\"last_modified\":\"$5\",\"amount\":59.90,\"currency\":\"BRL\",\"payer_id\":\"77\",\"date_created\":\"$T0\",\"next_payment_at\":\"2026-10-27T12:00:00Z\"}')::text"; }
EV() { Q "select string_agg(status, '>' order by occurred_at, id) from billing_subscription_events where preapproval_id = '$1'"; }

# --- assinatura: criação, repetição, fora de ordem -----------------------------------------
has "$(sync Nova@X.com trialing PRE1 authorized "$T0")" '"status": "trialing"' && ok "assinatura nova: conta em teste (e-mail normalizado)" || ko "nova"
[[ "$(Q "select plan_amount||'/'||currency||'/'||started_at::date from billing_accounts where email = 'nova@x.com'")" == "59.90/BRL/2026-10-20" ]] && ok "valor, moeda e início gravados" || ko "dados extras"
sync nova@x.com trialing PRE1 authorized "$T0" >/dev/null
[[ "$(EV PRE1)" == "trialing" ]] && ok "aviso repetido: histórico não duplica" || ko "duplicou: $(EV PRE1)"
sync nova@x.com active PRE1 authorized "2026-10-27T12:05:00Z" >/dev/null
[[ "$(Q "select status from billing_accounts where email = 'nova@x.com'")" == active ]] && ok "fim do teste: conta ativa" || ko "ativa"
has "$(sync nova@x.com trialing PRE1 authorized "2026-10-21T00:00:00Z")" '"applied": false' && ok "aviso ANTIGO chegando depois não volta a situação" || ko "fora de ordem aplicado"
[[ "$(Q "select status from billing_accounts where email = 'nova@x.com'")" == active ]] && ok "conta continua ativa" || ko "voltou para teste"
[[ "$(EV PRE1)" == "trialing>active" ]] && ok "histórico em ordem, sem repetir a mesma situação" || ko "histórico: $(EV PRE1)"
sync nova@x.com past_due PRE1 paused "2026-10-28T10:00:00Z" >/dev/null
sync nova@x.com canceled PRE1 cancelled "2026-11-02T10:00:00Z" >/dev/null
[[ "$(Q "select status||'/'||canceled_at::date from billing_accounts where email = 'nova@x.com'")" == "canceled/2026-11-02" ]] && ok "cancelamento: situação e data gravadas" || ko "cancelada"
[[ "$(EV PRE1)" == "trialing>active>past_due>canceled" ]] && ok "histórico completo da assinatura" || ko "histórico: $(EV PRE1)"
sync nova@x.com trialing PRE2 authorized "2026-11-10T10:00:00Z" >/dev/null
[[ "$(Q "select status||'/'||preapproval_id||'/'||coalesce(canceled_at::text,'-') from billing_accounts where email = 'nova@x.com'")" == "trialing/PRE2/-" ]] && ok "assinou de novo: nova assinatura assume, data de cancelamento limpa" || ko "reassinatura"
has "$(sync nova@x.com canceled PRE1 cancelled "2026-11-03T10:00:00Z")" '"applied": false' && ok "aviso atrasado da assinatura ANTIGA não derruba a nova" || ko "antiga derrubou a nova"

# --- cortesia --------------------------------------------------------------------------------
sync cortesia@x.com active PRE9 authorized "2026-10-22T10:00:00Z" >/dev/null
[[ "$(Q "select status||'/'||provider from billing_accounts where email = 'cortesia@x.com'")" == "free/cortesia" ]] && ok "cortesia nunca é rebaixada" || ko "cortesia mudou"
[[ "$(EV PRE9)" == "active" ]] && ok "assinatura da cortesia fica no histórico mesmo assim" || ko "histórico cortesia"

# --- validação ----------------------------------------------------------------------------------
has "$(SR "select billing_sync('{\"email\":\"\",\"status\":\"active\",\"preapproval_id\":\"P\"}')")" 22023 && ok "sem e-mail: recusado" || ko "sem e-mail"
has "$(SR "select billing_sync('{\"email\":\"a@b.c\",\"status\":\"vip\",\"preapproval_id\":\"P\"}')")" 22023 && ok "situação desconhecida: recusada" || ko "vip"

# --- cobranças -----------------------------------------------------------------------------------
pay() { SR "select billing_record_payment('{\"authorized_payment_id\":\"AP1\",\"preapproval_id\":\"PRE1\",\"email\":\"Nova@X.com\",\"payment_id\":\"PAY1\",\"ap_status\":\"processed\",\"status\":\"$1\",\"amount\":59.90,\"refunded_amount\":$2,\"fee_amount\":2.99,\"net_amount\":56.91,\"currency\":\"BRL\",\"paid_at\":\"2026-10-27T12:01:00Z\",\"last_modified\":\"$3\"}')::text"; }
has "$(pay approved 0 2026-10-27T12:01:00Z)" '"approved"' && ok "cobrança aprovada gravada" || ko "pagamento"
[[ "$(Q "select amount||'/'||fee_amount||'/'||net_amount||'/'||email from billing_payments where authorized_payment_id = 'AP1'")" == "59.90/2.99/56.91/nova@x.com" ]] && ok "bruto, taxa e líquido separados" || ko "valores"
pay approved 0 2026-10-27T12:01:00Z >/dev/null
[[ "$(Q "select count(*) from billing_payments")" == 1 ]] && ok "aviso repetido: uma cobrança só" || ko "duplicou cobrança"
has "$(pay rejected 0 2026-10-26T00:00:00Z)" '"applied": false' && ok "dado antigo da cobrança não substitui o novo" || ko "fora de ordem cobrança"
pay refunded 59.90 2026-11-01T09:00:00Z >/dev/null
[[ "$(Q "select status||'/'||refunded_amount from billing_payments where authorized_payment_id = 'AP1'")" == "refunded/59.90" ]] && ok "reembolso registrado" || ko "reembolso"
pay refunded 0 2026-11-02T09:00:00Z >/dev/null
[[ "$(Q "select refunded_amount from billing_payments where authorized_payment_id = 'AP1'")" == "59.90" ]] && ok "valor reembolsado não é apagado por um aviso incompleto" || ko "reembolso desfeito"
SR "select billing_record_payment('{\"authorized_payment_id\":\"AP2\",\"preapproval_id\":\"PRE1\",\"status\":\"inventado\"}')" >/dev/null
[[ "$(Q "select status from billing_payments where authorized_payment_id = 'AP2'")" == unknown ]] && ok "situação de cobrança desconhecida vira 'unknown'" || ko "unknown"
has "$(SR "select billing_record_payment('{\"preapproval_id\":\"PRE1\"}')")" 22023 && ok "cobrança sem id: recusada" || ko "sem id"

# --- compatibilidade --------------------------------------------------------------------------------
has "$(SR "select billing_upsert('antiga@x.com', 'active', 'PREX', null)")" active && ok "billing_upsert (0037) continua funcionando" || ko "billing_upsert quebrou"

echo "RESULTADO 0039: PASS=$pass FAIL=$fail"; dropdb --force $DB
