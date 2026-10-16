#!/usr/bin/env bash
# ============================================================================
# 0029 — central sem o rodapé de SAIR. SOMENTE LOCAL. Banco até a 0028.
# Prova: só campaign_text muda; a mensagem sai EXATAMENTE como escrita; o
# bloqueio de quem responde SAIR continua; sem envio duplicado; reversão exata.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DB="aurea_0029"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" 0028 >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
PSQL=(psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB")
Q() { "${PSQL[@]}" -c "$1"; }
U() { "${PSQL[@]}" -c "begin; set local \"request.jwt.claim.sub\" = '$1'; set local role authenticated; $2; commit;"; }
W() { "${PSQL[@]}" -c "begin; set local role wa_worker; $1; commit;"; }
OPS="$ROOT/operations/0029_aplicacao_supabase.sql"
blk() { sed -n "/^-- \[$1\]/,/^-- \[\/$1\]/p" "$OPS"; }
B() { psql -X -q -A -F'|' -t -d "$DB" -c "$(blk "$1")" 2>&1; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }

eval "$(Q "do \$\$ declare u uuid; a uuid; begin
  insert into auth.users (email) values ('own@z.local') returning id into u;
  insert into companies (name) values ('Studio Tainá') returning id into a;
  insert into company_members (company_id, user_id, role) values (a, u, 'owner');
end \$\$; select format('A=%s OWN=%s', (select id from companies where name = 'Studio Tainá'), (select id from auth.users where email = 'own@z.local'))")"
K1="$(Q "insert into clients (company_id, name, phone, comm_status) values ('$A', 'Tainá do Carmo', '11987658732', 'allowed') returning id")"
K2="$(Q "insert into clients (company_id, name, phone, comm_status) values ('$A', 'Bia Rocha', '11987650077', 'allowed') returning id")"
Q "insert into whatsapp_private.sessions (company_id, status, phone, last_seen_at, lease_owner, lease_until, connected_at)
   values ('$A', 'connected', '5511900000000', now(), 'w1', now() + interval '10 minutes', now())" >/dev/null
OTHER="select md5(string_agg(n.nspname || p.proname || md5(p.prosrc) || coalesce(p.proacl::text,''), '|' order by n.nspname, p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','whatsapp_private','aurea_private') and p.proname <> 'campaign_text'"
TRG="select md5(string_agg(pg_get_triggerdef(oid), '|' order by tgname)) from pg_trigger where not tgisinternal"
FN="select md5(p.prosrc || coalesce(p.proacl::text,'')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'whatsapp_private' and p.proname = 'campaign_text'"

[[ "$(B B0)" == "t|0" ]] && ok "B0 antes: a central acrescenta o rodapé ($(B B0))" || ko "B0: $(B B0)"
O0="$(Q "$OTHER")"; T0="$(Q "$TRG")"; F0="$(Q "$FN")"
psql -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/migrations/0029_whatsapp_campaign_no_footer.sql" >/dev/null 2>&1 && ok "B2 0029 aplicada" || ko "B2"
[[ "$(B B3)" == "f|t|0|13" ]] && ok "B3 depois: $(B B3)" || ko "B3: $(B B3)"
[[ "$(Q "$OTHER")" == "$O0" && "$(Q "$TRG")" == "$T0" ]] && ok "M1 só o texto da central mudou: confirmação, lembrete, avisos, fila, gatilhos e horários idênticos" || ko "M1"

TXT='Oi Tainá, se vc recebeu essa mensagem vc é trouxa'
R1="$(Q "select gen_random_uuid()")"
U "$OWN" "select wa_send_campaign('$A', array['$K1']::uuid[], '$TXT', '$R1')" >/dev/null
check "S1 mensagem sem variáveis: sai EXATAMENTE como escrita (exemplo do pedido)" \
  "(select body = '$TXT' from whatsapp_private.outbox where campaign_id = '$R1')"
R2="$(Q "select gen_random_uuid()")"
U "$OWN" "select wa_send_campaign('$A', array['$K1','$K2']::uuid[], E'Oi {nome}!\\n\\nNovidades no {negocio}.', '$R2')" >/dev/null
check "S2 mensagem com variáveis (modelo): variáveis trocadas e NADA acrescentado" \
  "(select bool_and(body in (E'Oi Tainá!\\n\\nNovidades no Studio Tainá.', E'Oi Bia!\\n\\nNovidades no Studio Tainá.')) and count(*) = 2 from whatsapp_private.outbox where campaign_id = '$R2')"
check "S3 nenhuma mensagem nova da fila tem a frase de SAIR" "not exists (select 1 from whatsapp_private.outbox where body ~* 'responda SAIR|não receber mais')"
EXP="$(node -e '
const { load } = require("/home/claude/hive-beauty/tests/load-ts.cjs");
const c = load("/home/claude/hive-beauty/lib/hive/communication.ts");
for (const [b, n] of [["  Oi {Nome}! {negocio} {xyz}  ", "Bia Rocha"], ["Oi Tainá, se vc recebeu essa mensagem vc é trouxa", "Tainá"], ["{nome}", ""]])
  console.log(JSON.stringify(c.campaignMessage(b, { clientName: n, companyName: "Studio Tainá" })));' | md5sum | cut -c1-32)"
SQLM="$(Q "select string_agg(to_json(whatsapp_private.campaign_text(b, n, 'Studio Tainá'))::text, E'\\n' order by i) from (values (1, '  Oi {Nome}! {negocio} {xyz}  ', 'Bia Rocha'), (2, 'Oi Tainá, se vc recebeu essa mensagem vc é trouxa', 'Tainá'), (3, '{nome}', '')) v(i, b, n)" | md5sum | cut -c1-32)"
[[ "$EXP" == "$SQLM" ]] && ok "S4 texto do banco = prévia da tela (paridade)" || ko "S4 $EXP vs $SQLM"
r="$(U "$OWN" "select wa_send_campaign('$A', array['$K1']::uuid[], '$TXT', '$R1')")"
[[ "$r" == *'"repeated": true'* && "$(Q "select count(*) from whatsapp_private.outbox where campaign_id = '$R1'")" == 1 ]] && ok "S5 sem envio duplicado: repetir o mesmo envio não enfileira de novo" || ko "S5 $r"

# bloqueio de quem responde SAIR continua igual
Q "update whatsapp_private.outbox set available_at = now() where campaign_id = '$R2'" >/dev/null
W "select whatsapp_private.record_inbound('$A', 'w1', 'IN-SAIR-Z', '5511987650077@s.whatsapp.net', 'SAIR')" >/dev/null
check "O1 cliente respondeu SAIR: continua sendo bloqueada (origem client_opt_out)" "(select comm_status = 'blocked' and comm_status_source = 'client_opt_out' from clients where id = '$K2')"
W "select count(*) from whatsapp_private.claim_outbox('w1', 50, 60)" >/dev/null
check "O2 ...e a mensagem que ainda não tinha saído para ela é cancelada na fila" \
  "(select status = 'canceled' from whatsapp_private.outbox where campaign_id = '$R2' and client_id = '$K2')"
c="$(U "$OWN" "select wa_send_campaign('$A', array['$K2']::uuid[], 'Oi', gen_random_uuid())" 2>&1)"
grep -q "AUW02" <<<"$c" && ok "O3 novo envio para quem saiu: recusado (ela não recebe mais nada da central)" || ko "O3 $c"

psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$(blk BR-SQL)" >/dev/null 2>&1 && ok "BR reversão executada" || ko "BR"
[[ "$(Q "$FN")" == "$F0" && "$(Q "$OTHER")" == "$O0" ]] && ok "BR voltou EXATAMENTE ao texto da 0028" || ko "BR"
echo "RESULTADO 0029: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
