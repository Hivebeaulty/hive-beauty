set -uo pipefail
export PGOPTIONS="-c client_min_messages=warning"; DB=aurea_0037; R="$(cd "$(dirname "$0")/../.." && pwd)"
$R/tests/local/fresh_db.sh $DB 0036 >/dev/null
Q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d $DB -c "$1"; }
U() { psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d $DB -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;" 2>&1; }
pass=0; fail=0; ok() { echo "PASS $1"; pass=$((pass+1)); }; ko() { echo "FAIL $1"; fail=$((fail+1)); }
for n in "Diêne Silva Nails:die@hotmail.com" "Ester Andrade Nail Designer:est@outlook.com" "Tainá Sobrancílios:pat@gmail.com" "Tainá Santos:tai@gmail.com"; do
  Q "do \$\$ declare u uuid; c uuid; begin insert into auth.users (email) values ('${n#*:}') returning id into u;
     insert into companies (name) values ('${n%%:*}') returning id into c; insert into company_members (company_id, user_id, role) values (c, u, 'owner'); end \$\$" >/dev/null
done
psql -X -q -1 -v ON_ERROR_STOP=1 -d $DB -f $R/migrations/0037_billing_access.sql >/dev/null 2>&1 && ok "0037 aplicada" || ko "0037"
[[ "$(Q "select string_agg(email || '=' || status, ' ' order by email) from billing_accounts")" == "die@hotmail.com=free est@outlook.com=free pat@gmail.com=free" ]] && ok "cortesia só para Diêne, Ester e Patrick (Tainá Santos fora)" || ko "cortesia: $(Q "select string_agg(email||'='||status,' ') from billing_accounts")"
uid() { Q "select id from auth.users where email = '$1'"; }; cid() { Q "select id from companies where name = '$1'"; }
[[ "$(U "$(uid die@hotmail.com)" "select get_company_access('$(cid 'Diêne Silva Nails')') ->> 'allowed'")" == true ]] && ok "Diêne: acesso liberado (gratuita)" || ko "Diêne"
[[ "$(U "$(uid tai@gmail.com)" "select get_company_access('$(cid 'Tainá Santos')')::text")" == *'"allowed": false'*'"none"'* || "$(U "$(uid tai@gmail.com)" "select get_company_access('$(cid 'Tainá Santos')') ->> 'status'")" == none ]] && ok "Tainá Santos: bloqueada até assinar (dados intactos)" || ko "Tainá Santos"
Q "set role service_role; select billing_upsert('Tai@Gmail.com', 'trialing', 'pre-1', now() + interval '7 days')" >/dev/null 2>&1
[[ "$(U "$(uid tai@gmail.com)" "select get_company_access('$(cid 'Tainá Santos')') ->> 'allowed'")" == true ]] && ok "Tainá Santos assinou (teste grátis): acesso liberado" || ko "trialing"
Q "set role service_role; select billing_upsert('pat@gmail.com', 'canceled', 'x', null)" >/dev/null 2>&1
[[ "$(Q "select status from billing_accounts where email = 'pat@gmail.com'")" == free ]] && ok "cortesia NUNCA é rebaixada por aviso de pagamento" || ko "rebaixou"
Q "set role service_role; select billing_upsert('tai@gmail.com', 'canceled', 'pre-1', null)" >/dev/null 2>&1
[[ "$(U "$(uid tai@gmail.com)" "select get_company_access('$(cid 'Tainá Santos')') ->> 'allowed'")" == false ]] && ok "cancelou: bloqueia de novo (sem apagar nada)" || ko "cancel"
[[ "$(U "$(uid tai@gmail.com)" "select billing_upsert('tai@gmail.com', 'active', null, null)")" == *42501* ]] && ok "usuária NÃO consegue se dar acesso pela API" || ko "upsert exposto"
[[ "$(U "$(uid tai@gmail.com)" "select count(*) from billing_accounts")" == *42501* ]] && ok "usuária NÃO lê a tabela de cobrança" || ko "tabela exposta"
[[ "$(U "$(uid die@hotmail.com)" "select get_company_access('$(cid 'Tainá Santos')')")" == *P0002* ]] && ok "outra empresa: não consulta" || ko "isolamento"
[[ "$(U "$(uid tai@gmail.com)" "select get_my_access() ->> 'status'")" == canceled && "$(U "$(uid die@hotmail.com)" "select get_my_access() ->> 'allowed'")" == true ]] && ok "get_my_access: cada usuária vê só a própria situação" || ko "get_my_access"
echo "RESULTADO 0037: PASS=$pass FAIL=$fail"; dropdb --force $DB
