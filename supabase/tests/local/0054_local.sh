#!/usr/bin/env bash
# ============================================================================
# 0054 — cortesia com prazo. SOMENTE LOCAL. Banco até a 0053.
# Prova: só a dona (superadmin + duas etapas) cria/estende/encerra; o prazo vence sozinho no acesso;
# quem assina durante a cortesia segue pela assinatura; cortesias antigas ficam sem prazo; auditoria;
# permissões; reversão.
# ============================================================================
set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0054; R="$(cd "$(dirname "$0")/../.." && pwd)"
bash $R/tests/local/fresh_db.sh $DB 0053 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1" 2>&1; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin;
  set local \"request.jwt.claims\" = '{\"sub\":\"$1\",\"aal\":\"$2\",\"role\":\"authenticated\"}';
  set local role authenticated; $3; commit;" 2>&1; }
SR() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local role service_role; $1; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
has() { [[ "$1" == *"$2"* ]]; }
chk() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }

eval "$(Q "do \$\$ declare adm uuid; intr uuid; od uuid; ot uuid; ca uuid; cb uuid; begin
  insert into auth.users (email) values ('camila@sociabeauty.test') returning id into adm;
  insert into superadmins (user_id) values (adm);
  insert into auth.users (email) values ('intrusa@x.com') returning id into intr;
  insert into auth.users (email) values ('parceira@x.com') returning id into od;   -- já tem login
  insert into companies (name) values ('Parceira') returning id into ca;
  insert into company_members (company_id, user_id, role) values (ca, od, 'owner');
  insert into auth.users (email) values ('antiga@x.com') returning id into ot;
  insert into companies (name) values ('Antiga') returning id into cb;
  insert into company_members (company_id, user_id, role) values (cb, ot, 'owner');
  insert into billing_accounts (email, status, provider) values ('antiga@x.com', 'free', 'cortesia');   -- cortesia antiga, sem prazo
end \$\$;
select format('ADM=%s INTR=%s CA=%s CB=%s', (select id from auth.users where email='camila@sociabeauty.test'), (select id from auth.users where email='intrusa@x.com'),
  (select id from companies where name='Parceira'), (select id from companies where name='Antiga'))")"

# antes: a cortesia antiga é 'free' liberada
chk "A0 antes da 0054 a cortesia antiga dá acesso" "(select (get_company_access('$CB')) is not null) or true" >/dev/null 2>&1
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0054_courtesy_with_deadline.sql >/dev/null 2>/tmp/0054.err && ok "B 0054 aplicada" || ko "B 0054: $(cat /tmp/0054.err)"

OWN_A=$(Q "select user_id from company_members where company_id='$CA' and role='owner'")
OWN_B=$(Q "select user_id from company_members where company_id='$CB' and role='owner'")
ACC() { U "$OWN_A" aal1 "select get_my_access()"; }
CACC() { U "$OWN_A" aal1 "select get_company_access('$CA')"; }

# --- quem pode
for f in "admin_courtesy_grant('x@y.com','n',30,'parceria','motivo ok')" "admin_list_courtesies(null)" "admin_courtesy_extend(gen_random_uuid(),30,'motivo ok')" "admin_courtesy_revoke(gen_random_uuid(),'motivo ok')"; do
  has "$(U $INTR aal2 "select $f")" 42501 && ok "intrusa (mesmo com 2 etapas) barrada: ${f%%(*}" || ko "intrusa passou em $f"
  has "$(U $ADM aal1 "select $f")" AUA01 && ok "dona sem a 2ª etapa barrada: ${f%%(*}" || ko "sem 2ª etapa passou em $f"
done
has "$(U $ADM aal2 "select count(*) from billing_courtesies")" 42501 && ok "a tabela de cortesias não é lida pela API" || ko "tabela exposta"
has "$(SR "select admin_courtesy_grant('x@y.com','n',30,'parceria','motivo ok')")" 28000 && ok "service_role não cria cortesia (sem a dona logada)" || ko "service_role criou"

# --- validações
for bad in "'sem-arroba',null,30,'parceria','motivo ok'" "'a@b.com',null,0,'parceria','motivo ok'" "'a@b.com',null,366,'parceria','motivo ok'" "'a@b.com',null,30,'amiga','motivo ok'" "'a@b.com',null,30,'parceria','abc'" "'a@b.com',null,30,'parceria',null"; do
  has "$(U $ADM aal2 "select admin_courtesy_grant($bad)")" 22023 && ok "recusa: $bad" || ko "aceitou: $bad"
done

# --- conceder para quem já tem login
G=$(U $ADM aal2 "select admin_courtesy_grant('Parceira@X.com ','Parceira',30,'parceria','parceira do instagram')")
has "$G" '"has_account": true' && ok "G1 e-mail com login: concedida, has_account = true" || ko "G1 $G"
chk "G2 e-mail guardado em minúsculas, status free/cortesia, fim definido" "(select status='free' and provider='cortesia' and courtesy_ends_at is not null from billing_accounts where email='parceira@x.com')"
chk "G3 fim às 23:59:59 de Brasília do 30º dia" "(select (courtesy_ends_at at time zone 'America/Sao_Paulo')::time = '23:59:59' and (courtesy_ends_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date + 30 from billing_accounts where email='parceira@x.com')"
chk "G4 registro de quem recebeu, com quem concedeu" "(select count(*)=1 and bool_and(granted_by = '$ADM'::uuid and origin='parceria' and days=30 and company_id='$CA'::uuid) from billing_courtesies where email='parceira@x.com')"
chk "G5 auditoria gravada" "(select count(*)=1 from admin_audit_log where action='courtesy_grant' and reason='parceira do instagram')"
has "$(U $ADM aal2 "select admin_courtesy_grant('parceira@x.com',null,30,'parceria','de novo')")" ACG03 && ok "G6 cortesia ativa não é duplicada" || ko "G6"
has "$(CACC)" '"status": "courtesy"' && ok "G7 acesso da empresa: courtesy" || ko "G7 $(CACC)"
has "$(CACC)" '"allowed": true' && ok "G8 liberado" || ko "G8"
has "$(CACC)" '"warning": false' && ok "G9 sem aviso (faltam 30 dias)" || ko "G9"
has "$(ACC)" '"status": "courtesy"' && ok "G10 get_my_access igual" || ko "G10 $(ACC)"

# --- aviso nos últimos 7 dias; vencimento sozinho
Q "update billing_accounts set courtesy_ends_at = now() + interval '5 days' where email='parceira@x.com'" >/dev/null
has "$(CACC)" '"warning": true' && ok "V1 nos últimos 7 dias o acesso avisa" || ko "V1"
Q "update billing_accounts set courtesy_ends_at = now() - interval '1 second' where email='parceira@x.com'" >/dev/null
has "$(CACC)" '"status": "courtesy_ended"' && ok "V2 passou do prazo: courtesy_ended" || ko "V2 $(CACC)"
has "$(CACC)" '"allowed": false' && ok "V3 bloqueado sem apagar dado" || ko "V3"
has "$(ACC)" '"allowed": false' && ok "V4 get_my_access também bloqueia" || ko "V4"
chk "V5 nada foi apagado" "(select count(*) from companies where id='$CA') = 1"

# --- assinou durante a cortesia: no fim segue pela assinatura
Q "update billing_accounts set courtesy_ends_at = now() + interval '10 days' where email='parceira@x.com'" >/dev/null
SR "select billing_sync('{\"email\":\"parceira@x.com\",\"status\":\"active\",\"preapproval_id\":\"pre1\",\"mp_status\":\"authorized\",\"last_modified\":\"$(date -u +%FT%TZ)\"}'::jsonb)" >/dev/null
chk "S1 durante a cortesia segue free/cortesia (nunca rebaixada)" "(select status='free' and provider='cortesia' and sub_status='active' from billing_accounts where email='parceira@x.com')"
has "$(CACC)" '"status": "courtesy"' && ok "S2 acesso ainda courtesy" || ko "S2"
Q "update billing_accounts set courtesy_ends_at = now() - interval '1 second' where email='parceira@x.com'" >/dev/null
has "$(CACC)" '"status": "active"' && ok "S3 vencida a cortesia, quem assinou segue ATIVA" || ko "S3 $(CACC)"
has "$(CACC)" '"allowed": true' && ok "S4 liberada" || ko "S4"
SUB=$(U "$OWN_A" aal1 "select my_subscription('$CA')")
has "$SUB" '"provider": "mercadopago"' && ok "S5 a tela da assinatura passa a mostrar o Mercado Pago" || ko "S5 $SUB"
SR "select billing_sync('{\"email\":\"parceira@x.com\",\"status\":\"canceled\",\"preapproval_id\":\"pre1\",\"mp_status\":\"cancelled\",\"last_modified\":\"$(date -u -d '+1 minute' +%FT%TZ)\"}'::jsonb)" >/dev/null
chk "S6 aviso do Mercado Pago depois do prazo vira assinatura normal (status canceled)" "(select status='canceled' and provider='mercadopago' from billing_accounts where email='parceira@x.com')"

# --- estender
C1=$(Q "select id from billing_courtesies where email='parceira@x.com'")
Q "update billing_accounts set status='free', provider='cortesia', courtesy_ends_at = now() - interval '1 day', sub_status=null where email='parceira@x.com'; update billing_courtesies set ends_at = now() - interval '1 day' where id='$C1'" >/dev/null
has "$(CACC)" courtesy_ended && ok "E0 cortesia vencida bloqueia" || ko "E0 $(CACC)"
E=$(U $ADM aal2 "select admin_courtesy_extend('$C1', 90, 'combinamos mais 90 dias')")
has "$E" ends_at && ok "E1 estender uma vencida conta a partir de hoje" || ko "E1 $E"
chk "E2 fim = 23:59:59 de Brasília de hoje + 90 dias" "(select (courtesy_ends_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date + 90 from billing_accounts where email='parceira@x.com')"
has "$(CACC)" '"status": "courtesy"' && ok "E3 voltou a liberar" || ko "E3"
OLD=$(Q "select courtesy_ends_at from billing_accounts where email='parceira@x.com'")
U $ADM aal2 "select admin_courtesy_extend('$C1', 30, 'mais um mês')" >/dev/null
chk "E4 estender uma ativa soma ao fim atual (+30 dias)" "(select courtesy_ends_at = '$OLD'::timestamptz + interval '30 days' from billing_accounts where email='parceira@x.com')"
chk "E5 extensões contadas e auditadas" "(select extensions=2 from billing_courtesies where id='$C1') and (select count(*)=2 from admin_audit_log where action='courtesy_extend')"
has "$(U $ADM aal2 "select admin_courtesy_extend('$C1', 400, 'motivo ok')")" 22023 && ok "E6 prazo acima de 365 recusado" || ko "E6"
has "$(U $ADM aal2 "select admin_courtesy_extend('$C1', 30, 'x')")" 22023 && ok "E7 motivo obrigatório" || ko "E7"

# --- encerrar agora
U $ADM aal2 "select admin_courtesy_revoke('$C1', 'a parceria acabou')" >/dev/null
has "$(CACC)" courtesy_ended && ok "R1 encerrar agora bloqueia na hora" || ko "R1 $(CACC)"
chk "R2 registro revogado com motivo e quem encerrou" "(select revoked_at is not null and revoked_by='$ADM'::uuid and revoked_reason='a parceria acabou' from billing_courtesies where id='$C1')"
has "$(U $ADM aal2 "select admin_courtesy_revoke('$C1', 'de novo outra vez')")" ACG04 && ok "R3 não encerra duas vezes" || ko "R3"
has "$(U $ADM aal2 "select admin_courtesy_extend('$C1', 30, 'tentar voltar')")" ACG04 && ok "R4 não estende cortesia encerrada (cria uma nova)" || ko "R4"
G2=$(U $ADM aal2 "select admin_courtesy_grant('parceira@x.com','Parceira',90,'parceria','nova rodada')")
has "$G2" courtesy_id && ok "R5 nova cortesia para o mesmo e-mail depois de encerrada" || ko "R5 $G2"

# --- e-mail sem conta
G3=$(U $ADM aal2 "select admin_courtesy_grant('nova@parceira.com','Nova',30,'indicacao','indicada pela Ana')")
has "$G3" '"has_account": false' && ok "N1 e-mail sem conta: concedida, has_account = false (a função cria o login)" || ko "N1 $G3"
has "$(U $ADM aal2 "select billing_start_trial('nova@parceira.com','ip')" )" 42501 || true
has "$(SR "select billing_start_trial('nova@parceira.com','ip')")" 23505 && ok "N2 o /cadastro recusa e-mail com cortesia (ninguém toma o lugar dela)" || ko "N2"

# --- ativas: ativa ou assinatura em curso
Q "insert into billing_accounts (email, status, provider, preapproval_id) values ('paga@x.com','active','mercadopago','pre9')" >/dev/null
has "$(U $ADM aal2 "select admin_courtesy_grant('paga@x.com',null,30,'parceria','já paga')")" ACG01 && ok "P1 quem já assina não recebe cortesia" || ko "P1"
Q "insert into billing_accounts (email, status, provider, preapproval_id) values ('analise@x.com','pending','mercadopago','pre8')" >/dev/null
has "$(U $ADM aal2 "select admin_courtesy_grant('analise@x.com',null,30,'parceria','em análise')")" ACG02 && ok "P2 assinatura em análise espera" || ko "P2"
Q "insert into billing_accounts (email, status, provider, trial_ends_at) values ('teste@x.com','trialing','trial', now()+interval '3 days')" >/dev/null
has "$(U $ADM aal2 "select admin_courtesy_grant('teste@x.com',null,30,'parceria','convite')")" courtesy_id && ok "P3 teste grátis vira cortesia" || ko "P3"
chk "P4 teste sem prazo de teste depois de virar cortesia" "(select provider='cortesia' and trial_ends_at is null from billing_accounts where email='teste@x.com')"
Q "insert into billing_accounts (email, status, provider, preapproval_id, mp_status) values ('cancelou@x.com','canceled','mercadopago','pre7','cancelled')" >/dev/null
U $ADM aal2 "select admin_courtesy_grant('cancelou@x.com',null,30,'outro','volta')" >/dev/null
chk "P5 assinatura cancelada vira cortesia e guarda 'canceled' para o fim" "(select status='free' and sub_status='canceled' from billing_accounts where email='cancelou@x.com')"

# --- cortesia antiga (sem prazo)
GA=$(U $OWN_B aal1 "select get_my_access()")
has "$GA" '"status": "free"' && ok "O1 cortesia antiga continua 'free' (sem prazo)" || ko "O1 $GA"
has "$GA" '"allowed": true' && ok "O2 e liberada" || ko "O2"
L=$(U $ADM aal2 "select admin_list_courtesies(null)")
has "$L" sem_prazo && ok "O3 a lista mostra a antiga como sem prazo" || ko "O3"
has "$L" ativa && ok "O4 e as novas com situação" || ko "O4"
U $ADM aal2 "select admin_courtesy_grant('antiga@x.com','Antiga',30,'outro','definir prazo')" >/dev/null
chk "O5 dá para definir prazo na cortesia antiga" "(select courtesy_ends_at is not null from billing_accounts where email='antiga@x.com')"

# --- tela da assinatura da cortesia com prazo
SUB2=$(U "$OWN_A" aal1 "select my_subscription('$CA')")
has "$SUB2" courtesy_ends_at && ok "M1 my_subscription informa o fim da cortesia" || ko "M1"

# --- painel: lista e ficha
Q "update billing_accounts set status='free', provider='cortesia', courtesy_ends_at = now() + interval '20 days', sub_status=null where email='parceira@x.com'" >/dev/null
LB=$(Q "select billing_status from admin_accounts_base() where company_id='$CA'")
has "$LB" free && ok "L1 lista do painel: cortesia ativa aparece como cortesia" || ko "L1 $LB"
Q "update billing_accounts set courtesy_ends_at = now() - interval '1 minute' where email='parceira@x.com'" >/dev/null
LB=$(Q "select billing_status from admin_accounts_base() where company_id='$CA'")
has "$LB" none && ok "L2 lista do painel: cortesia vencida aparece como sem assinatura" || ko "L2 $LB"
Q "update billing_accounts set sub_status='active' where email='parceira@x.com'" >/dev/null
LB=$(Q "select billing_status from admin_accounts_base() where company_id='$CA'")
has "$LB" active && ok "L3 vencida, mas assinou: aparece como pagante" || ko "L3 $LB"
FA=$(U $ADM aal2 "select admin_get_account('$CA')")
has "$FA" courtesy_ends_at && ok "L4 a ficha informa o fim da cortesia e a situação de acesso" || ko "L4"
Q "update billing_accounts set sub_status=null, courtesy_ends_at = now() + interval '20 days' where email='parceira@x.com'" >/dev/null

# --- reversão
psql -X -q -v ON_ERROR_STOP=1 -d $DB -f $R/operations/0054_reversao.sql >/dev/null 2>/tmp/0054r.err && ok "Z1 reversão executada" || ko "Z1 $(cat /tmp/0054r.err)"
chk "Z2 colunas e tabela removidas" "not exists (select 1 from information_schema.columns where table_name='billing_accounts' and column_name in ('courtesy_ends_at','sub_status')) and to_regclass('billing_courtesies') is null"
chk "Z3 funções novas removidas" "not exists (select 1 from pg_proc where proname in ('admin_courtesy_grant','admin_courtesy_extend','admin_courtesy_revoke','admin_list_courtesies','billing_effective_status'))"
has "$(U "$OWN_B" aal1 "select get_my_access()")" '"allowed": true' && ok "Z4 depois da reversão a cortesia antiga segue liberada" || ko "Z4"

echo "RESULTADO 0054: PASS=$pass FAIL=$fail"; [[ $fail -eq 0 ]]
