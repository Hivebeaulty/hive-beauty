#!/usr/bin/env bash
# ============================================================================
# 0040 — financeiro do painel. SOMENTE LOCAL (banco descartável).
# Cenário de novembro/2026 com valores calculados à mão:
#   PRE1 Alfa : teste 25/10, ativa 01/11, AP1 aprovada 01/11 59,90 (taxa 2,99, líquido 56,91), AP6 agendada 30/11
#   PRE2 Beta : teste 05/11 (coorte), AP2 aprovada 12/11 59,90 com reembolso parcial de 20,00, ativa 12/11
#   PRE3 Gama : teste 20/11 (coorte, ainda em teste)
#   PRE4 Delta: teste 01/10, ativa 08/10 (base paga em 01/11), AP5 recusada 08/11, cancelada 15/11 (churn)
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0040; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0039 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"aal\":\"$2\",\"role\":\"authenticated\"}';
  set local role authenticated; $3; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

Q "do \$\$ declare adm uuid; u uuid; c uuid; n text; i int := 0;
begin
  insert into auth.users (email, raw_user_meta_data) values ('admin@x.com', '{\"full_name\":\"Admin\"}') returning id into adm;
  insert into superadmins (user_id) values (adm);
  foreach n in array array['Alfa', 'Beta', 'Gama', 'Delta', 'Cortesia'] loop
    i := i + 1;
    insert into auth.users (email) values ('dona' || i || '@x.com') returning id into u;
    insert into companies (name) values (n) returning id into c;
    insert into company_members (company_id, user_id, role) values (c, u, 'owner');
  end loop;
  insert into auth.users (email) values ('intrusa@x.com');
  insert into billing_accounts (email, status, provider) values ('dona5@x.com', 'free', 'cortesia');
end \$\$" >/dev/null
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0040_admin_finance.sql >/dev/null 2>/tmp/0040.err && ok "0040 aplicada" || ko "0040: $(cat /tmp/0040.err)"

sync() { SR "select billing_sync('{\"email\":\"$1\",\"status\":\"$2\",\"preapproval_id\":\"$3\",\"mp_status\":\"$4\",\"last_modified\":\"$5\",\"amount\":59.90,\"next_payment_at\":\"${6:-2026-12-01T12:00:00Z}\"}')" >/dev/null; }
pay() { SR "select billing_record_payment('$1')" >/dev/null; }
sync dona1@x.com trialing PRE1 authorized 2026-10-25T12:00:00Z
sync dona1@x.com active PRE1 authorized 2026-11-01T10:00:00Z
pay '{"authorized_payment_id":"AP1","preapproval_id":"PRE1","email":"dona1@x.com","status":"approved","amount":59.90,"fee_amount":2.99,"net_amount":56.91,"paid_at":"2026-11-01T10:01:00Z"}'
pay '{"authorized_payment_id":"AP6","preapproval_id":"PRE1","email":"dona1@x.com","status":"scheduled","amount":59.90,"debit_date":"2026-11-30T10:00:00Z"}'
sync dona2@x.com trialing PRE2 authorized 2026-11-05T12:00:00Z
pay '{"authorized_payment_id":"AP2","preapproval_id":"PRE2","email":"dona2@x.com","status":"approved","amount":59.90,"refunded_amount":20.00,"paid_at":"2026-11-12T12:00:00Z"}'
sync dona2@x.com active PRE2 authorized 2026-11-12T12:05:00Z
sync dona3@x.com trialing PRE3 authorized 2026-11-20T12:00:00Z 2026-11-27T12:00:00Z
sync dona6@x.com trialing PRE7 authorized 2026-11-02T12:00:00Z
sync dona6@x.com canceled PRE7 cancelled 2026-11-04T12:00:00Z
sync dona4@x.com trialing PRE4 authorized 2026-10-01T12:00:00Z
sync dona4@x.com active PRE4 authorized 2026-10-08T12:00:00Z
pay '{"authorized_payment_id":"AP5","preapproval_id":"PRE4","email":"dona4@x.com","status":"rejected","amount":59.90,"debit_date":"2026-11-08T12:00:00Z","retry_attempt":1}'
sync dona4@x.com canceled PRE4 cancelled 2026-11-15T12:00:00Z

uid() { Q "select id from auth.users where email = '$1'"; }; cid() { Q "select id from companies where name = '$1'"; }
ADM=$(uid admin@x.com); IT=$(uid intrusa@x.com); D1=$(uid dona1@x.com)
ALFA=$(cid Alfa); BETA=$(cid Beta); DELTA=$(cid Delta); CORT=$(cid Cortesia)
NOV="'2026-11-01T03:00:00Z', '2026-12-01T03:00:00Z'"

# --- autorização ----------------------------------------------------------------------
for f in "admin_finance_overview($NOV)" "admin_list_billing('payments')" "admin_cancel_prepare('$BETA', 'motivo teste')" \
         "admin_cancel_finish('$BETA', gen_random_uuid(), true, null)" "admin_reconcile_targets()" "admin_log_reconcile('{}')"; do
  has "$(U $IT aal2 "select $f")" 42501 && ok "intrusa barrada: ${f%%(*}" || ko "intrusa passou: $f"
  has "$(U $ADM aal1 "select $f")" AUA01 && ok "superadmin sem MFA barrada: ${f%%(*}" || ko "aal1 passou: $f"
done
has "$(U $D1 aal2 "select admin_company_by_email('dona2@x.com')")" "permission denied" && ok "busca de empresa por e-mail não é exposta" || ko "admin_company_by_email exposto"

# --- números de novembro -------------------------------------------------------------------
F="$(U $ADM aal2 "select admin_finance_overview($NOV)::text")"
chk() { has "$F" "\"$1\": $2" && ok "$3" || ko "$3 (esperado $1=$2)"; }
chk gross_approved 119.80 "cobrado aprovado (bruto) = 59,90 + 59,90"
chk refunded 20.00 "reembolsos = 20,00"
chk received 99.80 "recebido = bruto − reembolsos"
chk fees 2.99 "taxas conhecidas = 2,99"
chk fees_unknown 1 "uma cobrança aprovada sem taxa informada (não vira zero escondido)"
chk net 56.91 "líquido só das aprovadas sem devolução"
chk paying_subscriptions 2 "duas assinaturas pagaram (base do ticket médio)"
chk pending_amount 59.90 "pendente = cobrança agendada (fora da receita)"
chk rejected_count 1 "uma cobrança recusada"
chk mrr_contracted 119.80 "MRR contratado = ativas Alfa + Beta pelo valor do plano"
chk cohort_trials 3 "coorte de novembro: 3 começaram em teste (Beta, Gama e a que desistiu)"
chk cohort_converted 1 "1 converteu (teve cobrança aprovada)"
chk cohort_still_trial 1 "1 ainda em teste (fica à parte)"
chk churn_base 1 "base paga em 01/11: Delta"
chk churn_canceled 1 "Delta cancelou em novembro: churn pago"
chk trial_canceled 1 "só quem desistiu AINDA em teste conta (Delta cancelou ativa)"
has "$F" '"month": "2026-11", "received": 99.80' && ok "receita por mês: novembro = 99,80" || ko "por mês"
has "$(U $ADM aal2 "select admin_finance_overview('2026-12-01', '2026-11-01')")" 22023 && ok "período invertido recusado" || ko "período"
O="$(U $ADM aal2 "select admin_finance_overview('2026-10-01T03:00:00Z', '2026-11-01T03:00:00Z')::text")"
has "$O" '"received": 0' && has "$O" '"churn_base": 0' && ok "outubro: sem receita e sem base (cobranças só em novembro)" || ko "outubro: $O"

# --- listas ------------------------------------------------------------------------------------
LP="$(U $ADM aal2 "select admin_list_billing('payments')::text")"
has "$LP" '"total": 4' && has "$LP" '"company_name": "Alfa"' && ok "lista de cobranças com o negócio de cada uma" || ko "lista pagamentos: $LP"
has "$(U $ADM aal2 "select admin_list_billing('events', 'canceled')::text")" '"company_name": "Delta"' && ok "filtro: cancelamentos" || ko "eventos cancelados"
has "$(U $ADM aal2 "select admin_list_billing('outra')")" 22023 && ok "lista desconhecida recusada" || ko "lista outra"

# --- ficha ---------------------------------------------------------------------------------------
D="$(U $ADM aal2 "select admin_get_account('$ALFA')::text")"
has "$D" '"id": "AP1"' && has "$D" '"id": "AP6"' && has "$D" '"received": 59.90' && ok "ficha: cobranças e total recebido da conta" || ko "ficha pagamentos"
has "$D" '"status": "active"' && has "$D" '"plan_amount": 59.90' && ok "ficha: histórico e valor do plano" || ko "ficha eventos"

# --- cancelamento ------------------------------------------------------------------------------------
has "$(U $ADM aal2 "select admin_cancel_prepare('$BETA', '  ')")" 22023 && ok "cancelar exige motivo" || ko "motivo"
has "$(U $ADM aal2 "select admin_cancel_prepare('$CORT', 'Pedido da dona')")" "não tem assinatura" && ok "cortesia sem assinatura: nada a cancelar" || ko "cortesia"
has "$(U $ADM aal2 "select admin_cancel_prepare('$DELTA', 'Pedido da dona')")" "já está cancelada" && ok "já cancelada: recusado" || ko "já cancelada"
P="$(U $ADM aal2 "select admin_cancel_prepare('$BETA', 'Pedido da dona por WhatsApp')::text")"
has "$P" '"preapproval_id": "PRE2"' && ok "pedido de cancelamento: devolve a assinatura certa" || ko "prepare: $P"
CORR=$(echo "$P" | grep -o '"correlation_id": "[^"]*"' | cut -d'"' -f4)
has "$(Q "select result||':'||reason from admin_audit_log where correlation_id = '$CORR'")" "requested:Pedido da dona por WhatsApp" && ok "pedido registrado na auditoria ANTES de falar com o Mercado Pago" || ko "audit requested"
has "$(U $ADM aal2 "select admin_cancel_finish('$BETA', gen_random_uuid(), true, null)")" P0002 && ok "conclusão sem pedido correspondente: recusada" || ko "finish sem pedido"
has "$(U $ADM aal2 "select admin_cancel_finish('$ALFA', '$CORR', true, null)")" P0002 && ok "conclusão em outra conta: recusada" || ko "finish outra conta"
U $ADM aal2 "select admin_cancel_finish('$BETA', '$CORR', true, 'ok')" >/dev/null
has "$(Q "select string_agg(result, ',' order by id) from admin_audit_log where action = 'cancel_subscription'")" "requested,ok" && ok "auditoria: pedido e resultado" || ko "audit finish"
[[ "$(Q "select status from billing_accounts where email = 'dona2@x.com'")" == active ]] && ok "o banco NÃO marca cancelada sozinho (só depois de confirmar no Mercado Pago)" || ko "cancelou sem MP"

# --- conciliação ----------------------------------------------------------------------------------------
has "$(U $ADM aal2 "select admin_reconcile_targets()::text")" '"PRE1", "PRE2", "PRE3", "PRE4", "PRE7"' && ok "conciliação: todas as assinaturas conhecidas" || ko "targets"
U $ADM aal2 "select admin_log_reconcile('{\"checked\":4,\"errors\":0,\"emails\":[\"x@y.z\"]}')" >/dev/null
[[ "$(Q "select result||'/'||(details->>'checked')||'/'||(details ? 'emails')::text from admin_audit_log where action = 'reconcile'")" == "ok/4/false" ]] && ok "conciliação registrada, sem e-mails na auditoria" || ko "reconcile audit"
has "$(psql -X -q -A -t -d $DB -c "delete from admin_audit_log" 2>&1)" 'não pode ser alterado' && ok "auditoria continua imutável" || ko "auditoria"

echo "RESULTADO 0040: PASS=$pass FAIL=$fail"; dropdb --force $DB
