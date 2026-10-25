#!/usr/bin/env bash
# ============================================================================
# 0045 — e-mail antes do pagamento, assinaturas sem dona e alerta. SOMENTE LOCAL.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0045; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0044 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"aal\":\"$2\",\"role\":\"authenticated\"}';
  set local role authenticated; $3; commit;" 2>&1; }
AN() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "begin; set local role anon; $1; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

[[ "$(Q "select count(*) from pg_proc where proname in ('mp_sync_candidates','billing_email_targets')")" == 2 ]] && ok "base com 0042 a 0044" || ko "base"
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0045_signup_intents_unlinked.sql >/dev/null 2>/tmp/0045.err && ok "0045 aplicada" || ko "0045: $(cat /tmp/0045.err)"
Q "do \$\$ declare adm uuid; begin insert into auth.users (email) values ('admin@x.com') returning id into adm; insert into superadmins (user_id) values (adm);
   insert into auth.users (email) values ('comum@x.com'); end \$\$" >/dev/null
ADM=$(Q "select id from auth.users where email='admin@x.com'"); CO=$(Q "select id from auth.users where email='comum@x.com'")

# permissões
for f in "signup_intent_register('a@x.com')" "mp_sync_candidates()" "mp_unlinked_report('{}')" "mp_unlinked_resolved('x')" "mp_manual_links()"; do
  has "$(AN "select $f")" "permission denied" && has "$(U $CO aal2 "select $f")" "permission denied" && ok "só o servidor: ${f%%(*}" || ko "aberto: $f"
done
for t in signup_intents mp_unlinked; do has "$(AN "select count(*) from $t")" "permission denied" && ok "tabela $t invisível pela API" || ko "$t exposta"; done
has "$(U $CO aal2 "select admin_list_unlinked()")" 42501 && ok "lista sem dona: só superadmin" || ko "lista aberta"
has "$(U $ADM aal1 "select admin_list_unlinked()")" AUA01 && ok "lista sem dona: exige MFA" || ko "sem MFA"

# 1. pré-cadastro
[[ "$(SR "select signup_intent_register('  Nova@Cliente.com ', '{\"utm_source\":\"instagram\",\"email\":\"x\"}')")" == t ]] && ok "e-mail registrado" || ko "registro"
[[ "$(Q "select email||' '||(utm->>'utm_source')||' '||coalesce(utm->>'email','-') from signup_intents")" == "nova@cliente.com instagram -" ]] && ok "e-mail normalizado; UTM guardada (sem dados extras)" || ko "normalização: $(Q "select email, utm from signup_intents")"
has "$(SR "select signup_intent_register('sem-arroba')")" "E-mail inválido" && ok "e-mail inválido recusado" || ko "inválido"
SR "select signup_intent_register('nova@cliente.com')" >/dev/null
[[ "$(Q "select count(*) from signup_intents")" == 1 ]] && ok "repetir o mesmo e-mail não duplica" || ko "duplicou"
Q "insert into signup_intents (email) select 'x'||g||'@spam.com' from generate_series(1,300) g" >/dev/null
has "$(SR "select signup_intent_register('mais-um@x.com')")" "Muitos cadastros" && ok "limite de 300 novos e-mails por hora" || ko "sem limite"
[[ "$(SR "select signup_intent_register('nova@cliente.com')")" == t ]] && ok "quem já estava registrado passa mesmo no limite" || ko "renovação"
Q "delete from signup_intents where email like '%@spam.com'" >/dev/null

# candidatas da mp-sync
Q "insert into auth.users (email, created_at) values ('conta-sem-assinatura@x.com', now() - interval '3 days'), ('antiga@x.com', now() - interval '200 days')" >/dev/null
Q "insert into signup_intents (email, updated_at) values ('velho@x.com', now() - interval '20 days'), ('pagante@x.com', now())" >/dev/null
Q "insert into billing_accounts (email, status, provider, preapproval_id) values ('pagante@x.com','trialing','mercadopago','PX')" >/dev/null
C="$(SR "select string_agg(e, ',' order by e) from mp_sync_candidates() e")"
has "$C" "nova@cliente.com" && ok "candidata: e-mail informado no site" || ko "intent fora: $C"
has "$C" "conta-sem-assinatura@x.com" && ok "candidata: conta sem assinatura (regra da 0044 mantida)" || ko "conta fora"
! has "$C" "velho@x.com" && ! has "$C" "pagante@x.com" && ! has "$C" "antiga@x.com" && ok "fora: e-mail com mais de 14 dias, quem já tem acesso e conta antiga" || ko "sobrou: $C"

# 2. assinaturas sem dona
SR "select mp_unlinked_report('{\"preapproval_id\":\"P9\",\"mp_status\":\"authorized\",\"amount\":\"59.90\",\"date_created\":\"2026-10-25T17:13:00Z\"}')" >/dev/null
SR "select mp_unlinked_report('{\"preapproval_id\":\"P9\",\"mp_status\":\"authorized\"}')" >/dev/null
[[ "$(Q "select count(*)||' '||amount from mp_unlinked group by amount")" == "1 59.90" ]] && ok "sem dona registrada uma vez (valor preservado)" || ko "report"
has "$(U $ADM aal2 "select admin_list_unlinked()::text")" '"preapproval_id": "P9"' && ok "aparece no painel" || ko "painel"
has "$(U $ADM aal2 "select admin_link_subscription('P9','x@x.com','abc')")" "motivo" && ok "ligar exige motivo" || ko "motivo"
has "$(U $ADM aal2 "select admin_link_subscription('P9','sem-arroba','Cliente confirmou por WhatsApp')")" "E-mail inválido" && ok "ligar exige e-mail válido" || ko "email"
has "$(U $ADM aal2 "select admin_link_subscription('NAOEXISTE','a@x.com','Cliente confirmou por WhatsApp')")" "não encontrada" && ok "assinatura inexistente recusada" || ko "inexistente"
has "$(U $ADM aal1 "select admin_link_subscription('P9','a@x.com','Cliente confirmou por WhatsApp')")" AUA01 && ok "ligar exige MFA" || ko "ligar sem MFA"
U $ADM aal2 "select admin_link_subscription('P9','Cliente.Nova@X.com','Cliente confirmou por WhatsApp')" >/dev/null
[[ "$(SR "select preapproval_id||' '||email from mp_manual_links()")" == "P9 cliente.nova@x.com" ]] && ok "mp-sync recebe o e-mail ligado no painel" || ko "manual links"
[[ "$(Q "select action||' '||result||' '||(details->>'email') from admin_audit_log where action='link_subscription'")" == "link_subscription requested cliente.nova@x.com" ]] && ok "ligação auditada" || ko "auditoria"
SR "select mp_unlinked_resolved('P9')" >/dev/null
[[ "$(SR "select count(*) from mp_manual_links()")" == 0 ]] && [[ "$(U $ADM aal2 "select jsonb_array_length(admin_list_unlinked())")" == 0 ]] && ok "resolvida: sai do painel e da mp-sync" || ko "resolvida"

# 3. alerta
SR "select mp_unlinked_report('{\"preapproval_id\":\"P10\",\"mp_status\":\"authorized\"}')" >/dev/null
[[ "$(SR "select jsonb_array_length(billing_email_targets(now())->'unlinked_alert')")" == 0 ]] && ok "alerta espera 10 minutos" || ko "alerta cedo"
A="$(SR "select billing_email_targets(now() + interval '11 minutes')->'unlinked_alert'")"
has "$A" '"preapproval_id": "P10"' && ok "alerta depois de 10 minutos sem dona" || ko "alerta: $A"
ID=$(SR "select billing_email_claim('unlinked_alert','P10','suporte@x.com')"); SR "select billing_email_finish($ID, true, 'm', null)" >/dev/null
[[ "$(SR "select jsonb_array_length(billing_email_targets(now() + interval '11 minutes')->'unlinked_alert')")" == 0 ]] && ok "alerta sai uma vez só" || ko "alerta repetido"
Q "update mp_unlinked set linked_email='z@x.com' where preapproval_id='P10'" >/dev/null
SR "select mp_unlinked_report('{\"preapproval_id\":\"P11\"}')" >/dev/null; Q "update mp_unlinked set linked_email='y@x.com' where preapproval_id='P11'" >/dev/null
[[ "$(SR "select jsonb_array_length(billing_email_targets(now() + interval '11 minutes')->'unlinked_alert')")" == 0 ]] && ok "já ligada no painel: sem alerta" || ko "alerta ligada"
has "$(SR "select billing_email_targets(now())::text")" '"welcome"' && ok "boas-vindas e aviso continuam (0042)" || ko "targets"

echo "RESULTADO 0045: PASS=$pass FAIL=$fail"; dropdb --force $DB
