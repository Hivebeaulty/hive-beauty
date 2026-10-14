#!/usr/bin/env bash
# ============================================================================
# 0017 — concorrência real (duas sessões ao mesmo tempo). SOMENTE LOCAL.
# Banco descartável (0001–0017, sem a 0016), apagado no fim.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="aurea_conc_0017"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -d "$DB" -c "$1"; }
UID_A="$(Q "select id from auth.users order by created_at limit 1")"
AS_USER="set request.jwt.claim.sub = '$UID_A'; set role authenticated;"
AS_WORKER="set role wa_worker;"

CO=$(Q "insert into companies (name) values ('ZZ-CONC-17') returning id" | head -1)
Q "insert into company_members (company_id, user_id, role) values ('$CO', '$UID_A', 'owner')" >/dev/null
CL=$(Q "insert into clients (company_id, name, phone) values ('$CO', 'Cliente', '11987654321') returning id" | head -1)
Q "insert into whatsapp_private.sessions (company_id, status, last_seen_at) values ('$CO', 'connected', now())" >/dev/null

pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1"; fail=$((fail+1)); }
check() { [[ "$(Q "select ($2)")" == "t" ]] && ok "$1" || ko "$1"; }
# A segura a transação por 2 s; B começa 0,6 s depois
race() { # nome, pre A, sql A, pre B, sql B -> grava saídas em /tmp/c17_A.out e /tmp/c17_B.out
  psql -X -q -A -t -d "$DB" >/tmp/c17_A.out 2>&1 <<SQL &
$2
\\set VERBOSITY verbose
begin;
$3;
select pg_sleep(2);
commit;
SQL
  sleep 0.6
  psql -X -q -A -t -d "$DB" >/tmp/c17_B.out 2>&1 <<SQL
$4
\\set VERBOSITY verbose
$5;
SQL
  wait
}

# K1 — dois workers disputam a posse da mesma sessão: só um ganha
race "K1" "$AS_WORKER" "select whatsapp_private.acquire_lease('$CO', 'w1', 60)" "$AS_WORKER" "select whatsapp_private.acquire_lease('$CO', 'w2', 60)"
[[ "$(grep -c '^t$' /tmp/c17_A.out)" == 1 && "$(grep -c '^f$' /tmp/c17_B.out)" == 1 ]] \
  && ok "K1 dois workers ao mesmo tempo: w1 fica com a sessão, w2 recebe 'não'" || { ko "K1"; cat /tmp/c17_A.out /tmp/c17_B.out; }
check "K1 dono final da sessão = w1" "(select lease_owner from whatsapp_private.sessions where company_id = '$CO') = 'w1'"

# K2 — mesma chave de envio ao mesmo tempo: 1 pedido, as duas chamadas recebem o MESMO id
Q "update whatsapp_private.sessions set last_seen_at = now() where company_id = '$CO'" >/dev/null
race "K2" "$AS_USER" "select wa_send_message('$CL', 'Oi', 'mesma-chave') ->> 'outbox_id'" "$AS_USER" "select wa_send_message('$CL', 'Oi', 'mesma-chave') ->> 'outbox_id'"
IA="$(grep -E '^[0-9a-f-]{36}$' /tmp/c17_A.out)"; IB="$(grep -E '^[0-9a-f-]{36}$' /tmp/c17_B.out)"
[[ -n "$IA" && "$IA" == "$IB" ]] && ok "K2 mesma chave em paralelo: as duas chamadas recebem o mesmo pedido" || { ko "K2 ($IA / $IB)"; cat /tmp/c17_B.out; }
check "K2 só 1 pedido gravado" "(select count(*) from whatsapp_private.outbox where idempotency_key = 'mesma-chave') = 1"

# K3 — limite por minuto em paralelo: com limite 1 (em 1 min, já há 1 envio da K2), ninguém passa;
#      com limite 2, só UMA das duas chamadas paralelas passa
Q "update whatsapp_private.settings set send_per_minute = 2" >/dev/null
race "K3" "$AS_USER" "select wa_send_message('$CL', 'a', 'k3-a') ->> 'created'" "$AS_USER" "select wa_send_message('$CL', 'b', 'k3-b') ->> 'created'"
NOK=$(( $(grep -c '^true$' /tmp/c17_A.out) + $(grep -c '^true$' /tmp/c17_B.out) ))
[[ "$NOK" == 1 ]] && grep -q AUW03 /tmp/c17_B.out && ok "K3 limite respeitado em paralelo: 1 passa, o outro recebe AUW03" || { ko "K3 ($NOK aceitos)"; cat /tmp/c17_A.out /tmp/c17_B.out; }
Q "update whatsapp_private.settings set send_per_minute = 20" >/dev/null

# K4 — duas chamadas da fila do mesmo worker em paralelo: conjuntos disjuntos (SKIP LOCKED)
Q "update whatsapp_private.sessions set lease_owner = 'w1', lease_until = now() + interval '5 minutes' where company_id = '$CO'" >/dev/null
Q "insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key)
   select '$CO', 'send_text', '$CL', '5511987654321', 'm' || g, 'fila-' || g from generate_series(1, 10) g" >/dev/null
race "K4" "$AS_WORKER" "select id from whatsapp_private.claim_outbox('w1', 6, 60)" "$AS_WORKER" "select id from whatsapp_private.claim_outbox('w1', 10, 60)"
grep -E '^[0-9a-f-]{36}$' /tmp/c17_A.out | sort > /tmp/c17_a; grep -E '^[0-9a-f-]{36}$' /tmp/c17_B.out | sort > /tmp/c17_b
NA=$(wc -l </tmp/c17_a); NB=$(wc -l </tmp/c17_b); NI=$(comm -12 /tmp/c17_a /tmp/c17_b | wc -l)
PEND=$(Q "select count(*) from whatsapp_private.outbox where company_id = '$CO' and kind = 'send_text' and status = 'pending'")
[[ "$NI" == 0 && "$NA" -ge 1 && $((NA + NB)) -ge 6 ]] && ok "K4 fila em paralelo: nenhum pedido pego duas vezes (A=$NA, B=$NB, em comum=$NI)" || ko "K4 A=$NA B=$NB comuns=$NI"

# K5 — cliente responde SAIR enquanto há mensagem na fila: o worker não pega
Q "update whatsapp_private.outbox set status = 'canceled' where company_id = '$CO'" >/dev/null
Q "update clients set comm_status = 'unknown' where id = '$CL'" >/dev/null
Q "insert into whatsapp_private.outbox (company_id, kind, client_id, to_phone, body, idempotency_key) values ('$CO', 'send_text', '$CL', '5511987654321', 'oi', 'k5')" >/dev/null
race "K5" "$AS_WORKER" "select whatsapp_private.record_inbound('$CO', 'w1', 'IN-K5', '5511987654321@s.whatsapp.net', 'SAIR') ->> 'opted_out'" \
          "$AS_WORKER" "select count(*) from whatsapp_private.claim_outbox('w1', 10, 60)"
grep -q '^0$' /tmp/c17_B.out && ok "K5 SAIR em paralelo com a fila: a fila esperou a gravação e entregou 0 pedidos ao worker" || { ko "K5 worker recebeu pedido"; cat /tmp/c17_B.out; }
psql -X -q -A -t -d "$DB" -c "set role wa_worker; select count(*) from whatsapp_private.claim_outbox('w1', 10, 60)" >/dev/null
check "K5 na volta seguinte da fila o pedido é cancelado e a cliente está bloqueada" \
  "(select status from whatsapp_private.outbox where idempotency_key = 'k5') = 'canceled' and (select comm_status from clients where id = '$CL') = 'blocked'"

# K6 — a mesma mensagem recebida entregue duas vezes em paralelo: grava uma vez
Q "update clients set comm_status = 'unknown' where id = '$CL'" >/dev/null
race "K6" "$AS_WORKER" "select whatsapp_private.record_inbound('$CO', 'w1', 'IN-K6', '5511987654321@s.whatsapp.net', 'oi') ->> 'inserted'" \
          "$AS_WORKER" "select whatsapp_private.record_inbound('$CO', 'w1', 'IN-K6', '5511987654321@s.whatsapp.net', 'oi') ->> 'inserted'"
check "K6 mensagem recebida em dobro, em paralelo: gravada uma única vez" \
  "(select count(*) from whatsapp_private.messages where wa_message_id = 'IN-K6') = 1"

echo "RESULTADO concorrência 0017: PASS=$pass FAIL=$fail"
dropdb --force "$DB"
[[ $fail -eq 0 ]]
