#!/usr/bin/env bash
# ============================================================================
# 0052 — teste grátis sem cartão. SOMENTE LOCAL.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0052; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0051 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"role\":\"authenticated\"}';
  set local role authenticated; $2; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

Q "do \$\$ declare u uuid; c uuid; begin
  insert into auth.users (email) values ('cortesia@x.com') returning id into u;
  insert into companies (name) values ('Cortesia') returning id into c;
  insert into company_members (company_id, user_id, role) values (c, u, 'owner');
  insert into billing_accounts (email, status, provider) values ('cortesia@x.com', 'free', 'cortesia');
  insert into auth.users (email) values ('equipe@x.com');
end \$\$" >/dev/null
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0052_trial_sem_cartao.sql >/dev/null 2>/tmp/0052.err && ok "0052 aplicada" || ko "0052: $(cat /tmp/0052.err)"
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0052_trial_sem_cartao.sql >/dev/null 2>/tmp/0052b.err && ok "0052 reaplicada sem erro" || ko "0052 de novo: $(cat /tmp/0052b.err)"

# --- reservar o teste --------------------------------------------------------------------------
T=$(SR "select billing_start_trial('  Nova@Exemplo.com ', 'ip1')")
has "$T" "trial_ends_at" && ok "T1 teste reservado para e-mail novo" || ko "T1 $T"
[[ "$(Q "select status || '/' || provider from billing_accounts where email = 'nova@exemplo.com'")" == "trialing/trial" ]] && ok "T2 linha em teste sem cartão, e-mail em minúsculas" || ko "T2"
[[ "$(Q "select (trial_ends_at - started_at) = interval '7 days' from billing_accounts where email = 'nova@exemplo.com'")" == "t" ]] && ok "T3 sete dias de teste" || ko "T3"
has "$(SR "select billing_start_trial('nova@exemplo.com', 'ip2')")" "23505" && ok "T4 o mesmo e-mail não ganha teste de novo" || ko "T4"
has "$(SR "select billing_start_trial('cortesia@x.com', 'ip2')")" "23505" && ok "T5 cortesia não vira teste" || ko "T5"
has "$(SR "select billing_start_trial('equipe@x.com', 'ip2')")" "23505" && ok "T6 quem já tem login (equipe convidada) não ganha teste" || ko "T6"
[[ "$(Q "select provider from billing_accounts where email = 'cortesia@x.com'")" == "cortesia" ]] && ok "T7 cortesia intacta" || ko "T7"
has "$(SR "select billing_start_trial('sem-arroba.com', 'ip2')")" "22023" && ok "T8 e-mail inválido recusado" || ko "T8"
has "$(SR "select billing_start_trial('ana sousa@x.com', 'ip2')")" "22023" && ok "T9 e-mail com espaço recusado" || ko "T9"
[[ "$(SR "select billing_start_trial('sara.souza@sss.com', 'ip9') ? 'trial_ends_at'")" == "t" ]] && ok "T10 e-mail com a letra s passa (expressão certa)" || ko "T10"
for i in 1 2 3 4; do SR "select billing_start_trial('lote$i@x.com', 'ipX')" >/dev/null; done
has "$(SR "select billing_start_trial('lote5@x.com', 'ipX')")" "trial_ends_at" && ok "T11 quinto cadastro do mesmo IP na hora passa" || ko "T11"
has "$(SR "select billing_start_trial('lote6@x.com', 'ipX')")" "54000" && ok "T12 sexto cadastro do mesmo IP na hora é barrado" || ko "T12"
Q "update trial_signups set created_at = now() - interval '2 hours' where ip_hash = 'ipX'" >/dev/null
has "$(SR "select billing_start_trial('lote7@x.com', 'ipX')")" "trial_ends_at" && ok "T13 depois de uma hora, o mesmo IP volta a poder" || ko "T13"

# --- desfazer a reserva -------------------------------------------------------------------------
SR "select billing_trial_release('lote7@x.com')" >/dev/null
[[ "$(Q "select count(*) from billing_accounts where email = 'lote7@x.com'")" == "0" ]] && ok "R1 reserva desfeita quando o login não foi criado" || ko "R1"
SR "select billing_trial_release('cortesia@x.com')" >/dev/null
[[ "$(Q "select count(*) from billing_accounts where email = 'cortesia@x.com'")" == "1" ]] && ok "R2 nunca apaga cortesia" || ko "R2"

# --- permissões ----------------------------------------------------------------------------------
for f in "billing_start_trial(text, text)" "billing_trial_release(text)"; do
  [[ "$(Q "select has_function_privilege('authenticated', '$f', 'execute') or has_function_privilege('anon', '$f', 'execute')")" == "f" ]] && ok "P1 $f só para o servidor" || ko "P1 $f"
done
[[ "$(Q "select has_table_privilege('authenticated', 'trial_signups', 'select')")" == "f" ]] && ok "P2 trial_signups fechada" || ko "P2"

# --- acesso ---------------------------------------------------------------------------------------
UID_N=$(Q "insert into auth.users (email) values ('nova@exemplo.com') returning id")
A=$(U $UID_N "select get_my_access()")
has "$A" '"status": "trialing"' && has "$A" '"allowed": true' && has "$A" '"warning": false' && has "$A" '"until"' && ok "A1 no teste: acesso liberado antes de criar a empresa" || ko "A1 $A"
CID=$(Q "insert into companies (name) values ('Nova') returning id")
Q "insert into company_members (company_id, user_id, role) values ('$CID', '$UID_N', 'owner')" >/dev/null
A=$(U $UID_N "select get_company_access('$CID')")
has "$A" '"status": "trialing"' && has "$A" '"allowed": true' && ok "A2 no teste: empresa com acesso" || ko "A2 $A"
Q "update billing_accounts set trial_ends_at = now() + interval '2 days' where email = 'nova@exemplo.com'" >/dev/null
has "$(U $UID_N "select get_company_access('$CID')")" '"warning": true' && ok "A3 aviso nos últimos 3 dias" || ko "A3"
Q "update billing_accounts set trial_ends_at = now() - interval '1 minute' where email = 'nova@exemplo.com'" >/dev/null
A=$(U $UID_N "select get_company_access('$CID')")
has "$A" '"status": "trial_ended"' && has "$A" '"allowed": false' && ok "A4 teste acabou: sem acesso, dados guardados" || ko "A4 $A"
has "$(U $UID_N "select get_my_access()")" '"trial_ended"' && ok "A5 teste acabou também antes da empresa" || ko "A5"
S=$(U $UID_N "select my_subscription('$CID')")
has "$S" '"provider": "trial"' && has "$S" '"can_cancel": false' && has "$S" '"trial_ends_at"' && ok "A6 tela Assinatura mostra o teste sem cartão" || ko "A6 $S"
# assinou no Mercado Pago com o mesmo e-mail: a MESMA linha vira Mercado Pago
SR "select billing_sync('{\"email\":\"nova@exemplo.com\",\"status\":\"trialing\",\"preapproval_id\":\"PRE-N\",\"mp_status\":\"authorized\",\"last_modified\":\"2026-11-09T12:00:00Z\",\"date_created\":\"2026-11-09T12:00:00Z\"}')" >/dev/null
[[ "$(Q "select provider || '/' || status || '/' || preapproval_id from billing_accounts where email = 'nova@exemplo.com'")" == "mercadopago/trialing/PRE-N" ]] && ok "A7 assinatura do Mercado Pago assume a mesma linha" || ko "A7"
A=$(U $UID_N "select get_company_access('$CID')")
has "$A" '"status": "trialing"' && has "$A" '"allowed": true' && ok "A8 depois de assinar, o acesso segue o Mercado Pago" || ko "A8 $A"
CU=$(Q "select id from auth.users where email = 'cortesia@x.com'"); CC=$(Q "select id from companies where name = 'Cortesia'")
has "$(U $CU "select get_company_access('$CC')")" '"status": "free"' && ok "A9 cortesia continua com acesso" || ko "A9"

echo "RESULTADO 0052: PASS=$pass FAIL=$fail"
[[ $fail -eq 0 ]]
