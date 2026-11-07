#!/usr/bin/env bash
# ============================================================================
# 0051 — assinatura vista e cancelada pela dona no app. SOMENTE LOCAL.
#   Alfa : dona1 (ativa, 2 cobranças), admin da equipe, profissional
#   Beta : dona2 (cortesia)
#   Gama : dona3 (em teste, sem cobrança)
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0051; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0050 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"role\":\"authenticated\"}';
  set local role authenticated; $2; commit;" 2>&1; }
A() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role anon; $1; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

Q "do \$\$ declare u uuid; c uuid; n text; i int := 0;
begin
  foreach n in array array['Alfa', 'Beta', 'Gama'] loop
    i := i + 1;
    insert into auth.users (email) values ('dona' || i || '@x.com') returning id into u;
    insert into companies (name) values (n) returning id into c;
    insert into company_members (company_id, user_id, role) values (c, u, 'owner');
  end loop;
  select id into c from companies where name = 'Alfa';
  insert into auth.users (email) values ('admin@x.com') returning id into u;
  insert into company_members (company_id, user_id, role) values (c, u, 'admin');
  insert into auth.users (email) values ('prof@x.com') returning id into u;
  insert into company_members (company_id, user_id, role) values (c, u, 'professional');
  insert into billing_accounts (email, status, provider) values ('dona2@x.com', 'free', 'cortesia');
end \$\$" >/dev/null
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0051_owner_subscription.sql >/dev/null 2>/tmp/0051.err && ok "0051 aplicada" || ko "0051: $(cat /tmp/0051.err)"
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0051_owner_subscription.sql >/dev/null 2>/tmp/0051b.err && ok "0051 reaplicada sem erro" || ko "0051 de novo: $(cat /tmp/0051b.err)"

uid() { Q "select id from auth.users where email = '$1'"; }
cid() { Q "select id from companies where name = '$1'"; }
D1=$(uid dona1@x.com); D2=$(uid dona2@x.com); D3=$(uid dona3@x.com); ADM=$(uid admin@x.com); PROF=$(uid prof@x.com)
ALFA=$(cid Alfa); BETA=$(cid Beta); GAMA=$(cid Gama)

sync() { local np=null; [[ -n "${7:-}" ]] && np="\"$7\""
  local r; r=$(SR "select billing_sync('{\"email\":\"$1\",\"status\":\"$2\",\"preapproval_id\":\"$3\",\"mp_status\":\"$4\",\"last_modified\":\"$5\",\"amount\":59.90,\"date_created\":\"$6\",\"next_payment_at\":$np,\"source\":\"${8:-webhook}\"}')")
  has "$r" "ERROR" && echo "sync falhou: $r" >&2; }
pay() { SR "select billing_record_payment('$1')" >/dev/null; }
NOW=$(Q "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")
D10=$(Q "select to_char((now() - interval '10 days') at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")
D3A=$(Q "select to_char((now() - interval '3 days') at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")
NEXT=$(Q "select to_char((now() + interval '27 days') at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")
sync dona1@x.com trialing PRE1 authorized "$D10" "$D10" "$NEXT"
sync dona1@x.com active PRE1 authorized "$D3A" "$D10" "$NEXT"
pay "{\"authorized_payment_id\":\"AP1\",\"preapproval_id\":\"PRE1\",\"email\":\"dona1@x.com\",\"status\":\"approved\",\"amount\":59.90,\"fee_amount\":2.99,\"net_amount\":56.91,\"paid_at\":\"$D3A\"}"
pay "{\"authorized_payment_id\":\"AP2\",\"preapproval_id\":\"PRE1\",\"email\":\"dona1@x.com\",\"status\":\"scheduled\",\"amount\":59.90,\"debit_date\":\"$NEXT\"}"
sync dona3@x.com trialing PRE3 authorized "$D3A" "$D3A" "$NEXT"

# --- ver a assinatura -----------------------------------------------------------------------
S=$(U $D1 "select my_subscription('$ALFA')")
has "$S" '"status": "active"' && has "$S" '"can_cancel": true' && has "$S" '"amount": 59.90' && ok "S1 dona vê a assinatura ativa e pode cancelar" || ko "S1 $S"
[[ "$(U $D1 "select jsonb_array_length(my_subscription('$ALFA') -> 'payments')")" == "2" ]] && ok "S2 duas cobranças no histórico" || ko "S2"
[[ "$(U $D1 "select my_subscription('$ALFA') -> 'payments' -> 0 ->> 'status'")" == "scheduled" ]] && ok "S3 a mais recente primeiro (a agendada)" || ko "S3"
! has "$S" "fee" && ! has "$S" "net" && ok "S4 sem taxa nem líquido do Mercado Pago" || ko "S4 $S"
has "$(U $ADM "select my_subscription('$ALFA')")" "42501" && ok "S5 admin da equipe não vê a assinatura" || ko "S5"
has "$(U $PROF "select my_subscription('$ALFA')")" "42501" && ok "S6 profissional não vê" || ko "S6"
has "$(U $D2 "select my_subscription('$ALFA')")" "42501" && ok "S7 dona de outra empresa não vê" || ko "S7"
has "$(A "select my_subscription('$ALFA')")" "permission denied" && ok "S8 anon sem acesso" || ko "S8"
S2=$(U $D2 "select my_subscription('$BETA')")
has "$S2" '"status": "free"' && has "$S2" '"can_cancel": false' && ok "S9 cortesia: não tem o que cancelar" || ko "S9 $S2"
S3=$(U $D3 "select my_subscription('$GAMA')")
has "$S3" '"status": "trialing"' && has "$S3" '"trial_ends_at"' && has "$S3" '"can_cancel": true' && ok "S10 em teste: mostra o fim do teste" || ko "S10 $S3"

# --- privilégios -----------------------------------------------------------------------------
has "$(U $D1 "select count(*) from billing_owner_requests")" "permission denied" && ok "P1 tabela de pedidos fechada para o app" || ko "P1"
has "$(U $D1 "select owner_email_for('$ALFA')")" "permission denied" && ok "P2 owner_email_for só por dentro" || ko "P2"
[[ "$(Q "select has_function_privilege('anon', 'owner_cancel_prepare(uuid, text)', 'execute')")" == "f" ]] && ok "P3 anon não cancela" || ko "P3"

# --- cancelar ---------------------------------------------------------------------------------
has "$(U $D2 "select owner_cancel_prepare('$BETA', 'teste')")" "22023" && ok "C1 cortesia não cancela" || ko "C1"
has "$(U $ADM "select owner_cancel_prepare('$ALFA', 'teste')")" "42501" && ok "C2 admin da equipe não cancela" || ko "C2"
P=$(U $D1 "select owner_cancel_prepare('$ALFA', '  Está caro para mim agora  ')")
has "$P" '"preapproval_id": "PRE1"' && ok "C3 dona prepara o cancelamento" || ko "C3 $P"
REQ=$(Q "select id from billing_owner_requests where company_id = '$ALFA'")
[[ "$(Q "select reason from billing_owner_requests where id = '$REQ'")" == "Está caro para mim agora" ]] && ok "C4 motivo guardado, sem espaços nas pontas" || ko "C4"
has "$(U $D1 "select owner_cancel_prepare('$ALFA', null)")" "55P03" && ok "C5 segundo clique não duplica o pedido" || ko "C5"
has "$(U $D1 "select my_subscription('$ALFA')")" '"cancel_pending": true' && ok "C6 tela mostra que está cancelando" || ko "C6"
has "$(U $D2 "select owner_cancel_finish('$REQ', true, 'x')")" "P0002" && ok "C7 outra usuária não fecha o pedido" || ko "C7"
# a função account-billing confirma no Mercado Pago e sincroniza com origem 'owner'
sync dona1@x.com canceled PRE1 cancelled "$NOW" "$D10" "" owner
F=$(U $D1 "select owner_cancel_finish('$REQ', true, 'cancelada no Mercado Pago')")
has "$F" '"status": "ending"' && has "$F" '"allowed": true' && ok "C8 cancelada com mês pago: acesso continua (ending)" || ko "C8 $F"
[[ "$(Q "select result from billing_owner_requests where id = '$REQ'")" == "ok" ]] && ok "C9 pedido registrado como ok" || ko "C9"
[[ "$(Q "select source from billing_subscription_events where preapproval_id = 'PRE1' and status = 'canceled'")" == "owner" ]] && ok "C10 histórico mostra que foi a dona" || ko "C10"
has "$(U $D1 "select my_subscription('$ALFA')")" '"can_cancel": false' && ok "C11 depois de cancelada, sem botão" || ko "C11"
has "$(U $D1 "select owner_cancel_prepare('$ALFA', null)")" "já está cancelada" && ok "C12 não cancela duas vezes" || ko "C12"
# em teste, sem cobrança: acesso termina quando o Mercado Pago confirma
P3=$(U $D3 "select owner_cancel_prepare('$GAMA', null)"); REQ3=$(Q "select id from billing_owner_requests where company_id = '$GAMA'")
sync dona3@x.com canceled PRE3 cancelled "$NOW" "$D3A" "" owner
F3=$(U $D3 "select owner_cancel_finish('$REQ3', true, 'ok')")
has "$F3" '"status": "canceled"' && has "$F3" '"allowed": false' && ok "C13 cancelada no teste: acesso termina" || ko "C13 $F3"
# erro no Mercado Pago fica registrado
SR "update billing_accounts set mp_status = 'authorized', status = 'trialing' where email = 'dona3@x.com'" >/dev/null
Q "update billing_owner_requests set created_at = now() - interval '5 minutes' where company_id = '$GAMA'" >/dev/null
U $D3 "select owner_cancel_prepare('$GAMA', null)" >/dev/null
REQ4=$(Q "select id from billing_owner_requests where company_id = '$GAMA' and result = 'requested'")
U $D3 "select owner_cancel_finish('$REQ4', false, 'MP 500: erro')" >/dev/null
[[ "$(Q "select result || ':' || detail from billing_owner_requests where id = '$REQ4'")" == "error:MP 500: erro" ]] && ok "C14 falha do Mercado Pago registrada" || ko "C14"

# --- billing_sync continua igual para as outras origens -----------------------------------------
sync dona9@x.com trialing PRE9 authorized "$NOW" "$NOW" "" estranha
[[ "$(Q "select source from billing_subscription_events where preapproval_id = 'PRE9'")" == "webhook" ]] && ok "B1 origem desconhecida continua virando webhook" || ko "B1"
[[ "$(Q "select status from billing_accounts where email = 'dona2@x.com'")" == "free" ]] && ok "B2 cortesia intacta" || ko "B2"

echo "RESULTADO 0051: PASS=$pass FAIL=$fail"
[[ $fail -eq 0 ]]
