#!/usr/bin/env bash
# ============================================================================
# 0038 — SUPERADMIN. SOMENTE LOCAL: banco descartável (fresh_db.sh), apagado no fim.
# Autorização (superadmin + MFA aal2), isolamento, RLS endurecido, suspensão
# (bloqueia sem apagar e sem mexer na cobrança), observações, exportação e
# auditoria somente-inclusão.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0038; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0037 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1"; }
# U <user_id> <aal> <sql>: sessão autenticada como no Supabase (JWT com sub e aal)
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"aal\":\"$2\",\"role\":\"authenticated\"}';
  set local role authenticated; $3; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }

# --- estado parecido com produção, ANTES da 0038 --------------------------------
Q "do \$\$ declare adm uuid; d1 uuid; d2 uuid; pr uuid; it uuid; ca uuid; cb uuid; cd uuid; ma uuid; s uuid; cl uuid;
begin
  insert into auth.users (email, raw_user_meta_data) values ('admin@x.com', '{\"full_name\":\"Admin\"}') returning id into adm;
  insert into auth.users (email, raw_user_meta_data, last_sign_in_at) values ('dona1@x.com', '{\"full_name\":\"Dona Um\"}', now()) returning id into d1;
  insert into auth.users (email, raw_user_meta_data) values ('dona2@x.com', '{\"full_name\":\"Dona Dois\"}') returning id into d2;
  insert into auth.users (email) values ('prof@x.com') returning id into pr;
  insert into auth.users (email) values ('intruso@x.com') returning id into it;
  insert into companies (name) values ('Studio Alfa') returning id into ca;
  insert into companies (name) values ('Beleza Beta') returning id into cb;
  insert into companies (name, is_demo) values ('Demo', true) returning id into cd;
  insert into company_members (company_id, user_id, role) values (ca, d1, 'owner') returning id into ma;
  insert into company_members (company_id, user_id, role) values (ca, pr, 'professional');
  insert into company_members (company_id, user_id, role) values (cb, d2, 'owner');
  insert into billing_accounts (email, status, provider) values ('dona1@x.com', 'active', 'mercadopago');
  insert into services (company_id, name, duration_minutes, price) values (ca, 'Manicure', 60, 50) returning id into s;
  insert into clients (company_id, name) values (ca, 'Cliente Final') returning id into cl;
  insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
    values (ca, cl, s, ma, now() + interval '2 days', now() + interval '2 days 1 hour', 50);
  insert into superadmins (user_id) values (adm);  -- provisionamento manual (SQL Editor)
end \$\$" >/dev/null
SNAP="select (select count(*) from companies)||'/'||(select count(*) from company_members)||'/'||(select count(*) from appointments)||'/'||(select count(*) from clients)||'/'||(select string_agg(email||'='||status, ',' order by email) from billing_accounts)"
BEFORE="$(Q "$SNAP")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0038_superadmin.sql >/dev/null 2>/tmp/0038.err && ok "0038 aplicada" || { ko "0038: $(cat /tmp/0038.err)"; }
[[ "$(Q "$SNAP")" == "$BEFORE" ]] && ok "dados existentes intactos ($BEFORE)" || ko "dados mudaram"

uid() { Q "select id from auth.users where email = '$1'"; }; cid() { Q "select id from companies where name = '$1'"; }
ADM=$(uid admin@x.com); D1=$(uid dona1@x.com); D2=$(uid dona2@x.com); PR=$(uid prof@x.com); IT=$(uid intruso@x.com)
CA=$(cid 'Studio Alfa'); CB=$(cid 'Beleza Beta')

# --- quem NÃO é superadmin --------------------------------------------------------
has "$(U $IT aal2 "select admin_whoami() ->> 'is_superadmin'")" false && ok "intrusa: admin_whoami diz que não é superadmin" || ko "whoami intrusa"
for f in "admin_overview(now() - interval '30 days', now())" "admin_list_accounts()" "admin_get_account('$CA')" \
         "admin_set_suspension('$CA', true, 'teste de abuso')" "admin_add_note('$CA', 'x')" "admin_list_audit()" "admin_export_accounts()"; do
  has "$(U $IT aal2 "select $f")" 42501 && ok "intrusa (mesmo com MFA) barrada: ${f%%(*}" || ko "intrusa passou em $f"
done
has "$(U $IT aal2 "insert into superadmins (user_id) values (auth.uid())")" 42501 && ok "ninguém se torna superadmin pela API" || ko "auto-promoção possível"
has "$(U $IT aal2 "select count(*) from admin_audit_log")" 42501 && ok "auditoria não é legível pela API" || ko "auditoria exposta"
has "$(U $IT aal2 "select count(*) from admin_account_flags")" 42501 && ok "suspensões não são legíveis pela API" || ko "flags expostas"
has "$(U $IT aal2 "select admin_log('x', null, 'ok', null, '{}')")" 42501 && ok "admin_log não é chamável pela API" || ko "admin_log exposto"
has "$(U $D1 aal2 "select admin_get_account('$CB')")" 42501 && ok "dona de outra conta não lê a ficha da vizinha" || ko "isolamento"

# --- superadmin SEM MFA -------------------------------------------------------------
has "$(U $ADM aal1 "select admin_whoami()::text")" '"mfa_ok": false' && ok "superadmin sem MFA: whoami pede MFA" || ko "whoami aal1"
has "$(U $ADM aal1 "select admin_list_accounts()")" AUA01 && ok "superadmin sem MFA: barrada (AUA01)" || ko "aal1 passou"

# --- superadmin COM MFA -------------------------------------------------------------
OV="$(U $ADM aal2 "select admin_overview(now() - interval '30 days', now() + interval '1 minute')::text")"
has "$OV" '"total": 2' && has "$OV" '"demo": 1' && ok "visão geral: 2 contas reais, demo separada" || ko "overview total: $OV"
has "$OV" '"active": 1' && has "$OV" '"none": 1' && ok "visão geral: situação de assinatura pela regra do app" || ko "by_status: $OV"
has "$OV" '"mrr_estimated": 59.90' && ok "MRR estimado = 1 ativa × R\$ 59,90" || ko "mrr: $OV"
has "$OV" '"new_in_period": 2' && ok "novas no período" || ko "new: $OV"
has "$(U $ADM aal2 "select admin_overview(now(), now() - interval '1 day')")" 22023 && ok "período inválido recusado" || ko "período"

L="$(U $ADM aal2 "select admin_list_accounts('alfa')::text")"
has "$L" '"total": 1' && has "$L" 'Studio Alfa' && has "$L" '"appointments_count": 1' && ok "busca por nome da empresa + contagens" || ko "busca: $L"
has "$(U $ADM aal2 "select admin_list_accounts('DONA2@')::text")" 'Beleza Beta' && ok "busca por e-mail da dona (sem diferenciar maiúsculas)" || ko "busca e-mail"
has "$(U $ADM aal2 "select admin_list_accounts(null, 'none')::text")" '"total": 1' && ok "filtro por situação da assinatura" || ko "filtro billing"
P="$(U $ADM aal2 "select (admin_list_accounts(null, null, null, null, null, 'name_asc', 1, 1))::text")"
has "$P" '"total": 2' && has "$P" 'Studio Alfa' && ! has "$P" 'Beleza Beta' && ok "paginação + ordem por nome" || ko "paginação: $P"
D="$(U $ADM aal2 "select admin_get_account('$CA')::text")"
has "$D" '"appointments_upcoming": 1' && has "$D" '"clients": 1' && ! has "$D" 'prof@x.com' && ! has "$D" 'Cliente Final' \
  && ok "ficha: uso por contagens; sem e-mail da equipe nem nome de cliente final" || ko "ficha: $D"

# --- suspensão ----------------------------------------------------------------------
has "$(U $ADM aal2 "select admin_set_suspension('$CA', true, '  ')")" 22023 && ok "suspender exige motivo" || ko "motivo"
has "$(U $ADM aal2 "select admin_set_suspension('$CA', true, 'Pedido da própria dona')::text")" '"changed": true' && ok "conta suspensa" || ko "suspender"
has "$(U $D1 aal1 "select get_company_access('$CA')::text")" '"suspended"' && ok "dona suspensa: sem acesso (status suspended)" || ko "acesso dona"
has "$(U $PR aal1 "select get_company_access('$CA') ->> 'allowed'")" false && ok "equipe da conta suspensa também sem acesso" || ko "acesso equipe"
has "$(U $D2 aal1 "select get_company_access('$CB') ->> 'status'")" none && ok "outras contas não são afetadas" || ko "vizinha afetada"
[[ "$(Q "$SNAP")" == "$BEFORE" ]] && ok "suspensão não apagou nada nem mexeu na cobrança" || ko "suspensão alterou dados"
has "$(U $ADM aal2 "select admin_set_suspension('$CA', false, 'Situação resolvida')::text")" '"changed": true' && ok "conta reativada" || ko "reativar"
has "$(U $D1 aal1 "select get_company_access('$CA')::text")" '"active"' && ok "reativada: acesso volta pela assinatura (sem nova cobrança)" || ko "pós-reativação"
has "$(U $ADM aal2 "select admin_set_suspension('$CA', false, 'Clique repetido')::text")" '"changed": false' && ok "reativar de novo: nada muda (registrado como noop)" || ko "noop"

# --- observações, exportação, auditoria ---------------------------------------------
has "$(U $ADM aal2 "select admin_add_note('$CA', '   ')")" 22023 && ok "observação vazia recusada" || ko "nota vazia"
U $ADM aal2 "select admin_add_note('$CA', 'Ligou pedindo ajuda com o WhatsApp')" >/dev/null
has "$(U $ADM aal2 "select admin_get_account('$CA') -> 'notes'")" 'ajuda com o WhatsApp' && ok "observação aparece na ficha" || ko "nota"
has "$(U $ADM aal2 "select jsonb_array_length(admin_export_accounts() -> 'rows')")" 2 && ok "exportação: todas as contas reais do filtro" || ko "export"
has "$(U $ADM aal2 "select (admin_list_accounts(null, null, null, null, null, 'created_desc', 25, 0, true))::text")" '"total": 3' && ok "demonstração aparece só quando pedida" || ko "demo opcional"
A="$(Q "select string_agg(action||':'||result, ',' order by id) from admin_audit_log where admin_id = '$ADM'")"
[[ "$A" == "view_account:ok,suspend:ok,reactivate:ok,reactivate:noop,add_note:ok,view_account:ok,export_accounts:ok" ]] \
  && ok "auditoria registra cada ação, na ordem, com a superadmin responsável" || ko "auditoria: $A"
has "$(Q "select reason from admin_audit_log where action = 'suspend'")" 'Pedido da própria dona' && ok "motivo gravado na auditoria" || ko "motivo audit"
has "$(Q "select details ->> 'rows' from admin_audit_log where action = 'export_accounts'")" 2 && ok "exportação registra quantas linhas saíram" || ko "export audit"
has "$(psql -X -q -A -t -d $DB -c "delete from admin_audit_log" 2>&1)" 'não pode ser alterado' && ok "auditoria imutável até para o dono do banco" || ko "auditoria apagável"
has "$(psql -X -q -A -t -d $DB -c "update admin_audit_log set reason = 'x'" 2>&1)" 'não pode ser alterado' && ok "auditoria não aceita edição" || ko "auditoria editável"
has "$(U $ADM aal2 "select (admin_list_audit('$CA'))::text")" '"admin_name": "Admin"' && ok "superadmin lê a auditoria da conta" || ko "list_audit"

# --- RLS endurecido -------------------------------------------------------------------
[[ "$(U $ADM aal2 "with x as (update companies set name = 'HACK' where id = '$CB' returning 1) select count(*) from x")" == 0 ]] \
  && ok "superadmin NÃO edita empresas direto pela API (só por funções auditadas)" || ko "superadmin editou empresa"
[[ "$(U $ADM aal2 "with x as (delete from companies where id = '$CB' returning 1) select count(*) from x")" == 0 ]] \
  && ok "superadmin NÃO apaga empresas pela API" || ko "superadmin apagou empresa"
[[ "$(U $ADM aal2 "with x as (update company_members set active = false where company_id = '$CB' returning 1) select count(*) from x")" == 0 ]] \
  && ok "superadmin NÃO mexe na equipe de outra conta pela API" || ko "superadmin mexeu em membros"
[[ "$(U $D1 aal1 "with x as (update companies set phone = '11999999999' where id = '$CA' returning 1) select count(*) from x")" == 1 ]] \
  && ok "dona continua editando a PRÓPRIA empresa (app normal intacto)" || ko "dona perdeu edição"
[[ "$(U $D1 aal1 "with x as (update companies set name = 'X' where id = '$CB' returning 1) select count(*) from x")" == 0 ]] \
  && ok "dona não edita empresa alheia" || ko "dona editou alheia"

echo "RESULTADO 0038: PASS=$pass FAIL=$fail"; dropdb --force $DB
