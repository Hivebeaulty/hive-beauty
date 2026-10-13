#!/usr/bin/env bash
# ============================================================================
# Contrato W3: as respostas REAIS das RPCs da 0017 (Postgres local, como a
# usuária logada) passam pelas funções de leitura da tela (lib/hive/whatsapp.ts)
# sem perda. Cobre owner e profissional, em cada estado. SOMENTE LOCAL.
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB="aurea_ui_contract"
export PGOPTIONS="-c client_min_messages=warning"
"$HERE/fresh_db.sh" "$DB" >/dev/null || { echo "FALHA ao montar o banco"; exit 1; }
Q() { psql -X -q -A -t -d "$DB" -c "$1"; }
UID_A="$(Q "select id from auth.users order by created_at limit 1")"
CO=$(Q "insert into companies (name) values ('ZZ-UI') returning id" | head -1)
MEM=$(Q "insert into company_members (company_id, user_id, role) values ('$CO', '$UID_A', 'owner') returning id" | head -1)
AS() { psql -X -q -A -t -d "$DB" -c "set request.jwt.claim.sub = '$UID_A'; set role authenticated; $1" | tail -1; }
OUT=/tmp/ui_contract.jsonl; : > "$OUT"
put() { printf '{"case":"%s","kind":"%s","json":%s}\n' "$1" "$2" "$3" >> "$OUT"; }

put "owner-sem-sessao" status "$(AS "select wa_get_status('$CO')")"
put "owner-pediu-conexao" request "$(AS "select wa_request_connection('$CO')")"
put "owner-connect_requested" status "$(AS "select wa_get_status('$CO')")"
Q "update whatsapp_private.sessions set status = 'qr_pending', last_seen_at = now() where company_id = '$CO';
   insert into whatsapp_private.qr (company_id, qr, expires_at) values ('$CO', '2@QR-CONTRATO-abcdefghijk', now() + interval '60 seconds')" >/dev/null
put "owner-qr_pending" status "$(AS "select wa_get_status('$CO')")"
put "owner-qr" qr "$(AS "select wa_get_qr('$CO')")"
Q "update whatsapp_private.sessions set status = 'connected', phone = '5511987654321', connected_at = now(), last_seen_at = now() where company_id = '$CO';
   delete from whatsapp_private.qr where company_id = '$CO'" >/dev/null
put "owner-connected" status "$(AS "select wa_get_status('$CO')")"
put "owner-qr-sem-qr" qr "$(AS "select wa_get_qr('$CO')")"
Q "update whatsapp_private.sessions set last_seen_at = now() - interval '5 minutes' where company_id = '$CO'" >/dev/null
put "owner-stale" status "$(AS "select wa_get_status('$CO')")"
Q "update whatsapp_private.sessions set status = 'error', last_error = 'Sessão aberta em outro lugar.', last_seen_at = now() where company_id = '$CO'" >/dev/null
put "owner-error" status "$(AS "select wa_get_status('$CO')")"
put "owner-desconectar" disconnect "$(AS "select wa_disconnect('$CO')")"
Q "update company_members set role = 'professional' where id = '$MEM'" >/dev/null
put "profissional-error" status "$(AS "select wa_get_status('$CO')")"
ERRQR="$(psql -X -q -A -t -d "$DB" -c "\\set VERBOSITY verbose" -c "set request.jwt.claim.sub = '$UID_A'; set role authenticated; select wa_get_qr('$CO')" 2>&1 | grep -o '42501' | head -1)"

cd "$ROOT" && node - "$OUT" "$ERRQR" <<'NODE'
const fs = require("fs");
const { load } = require(process.cwd() + "/tests/load-ts.cjs");
const wa = load("lib/hive/whatsapp.ts");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const by = Object.fromEntries(rows.map((r) => [r.case, r.json]));
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name); } };
const s = (c) => wa.parseStatus(by[c]);
ok("C1 sem sessão: tela lê 'disconnected', owner pode gerir, sem QR", s("owner-sem-sessao")?.status === "disconnected" && s("owner-sem-sessao").canManage && !s("owner-sem-sessao").qrAvailable);
ok("C2 pedir conexão devolve connect_requested", by["owner-pediu-conexao"]?.status === "connect_requested");
ok("C3 status connect_requested lido", s("owner-connect_requested")?.status === "connect_requested");
ok("C4 qr_pending com qr_available para owner", s("owner-qr_pending")?.status === "qr_pending" && s("owner-qr_pending").qrAvailable === true);
const q = wa.parseQr(by["owner-qr"]);
ok("C5 QR real lido (texto + validade), com prazo local de no máximo 60 s", q?.value === "2@QR-CONTRATO-abcdefghijk" && wa.qrLocalDeadline(q.expiresAt, Date.now()) - Date.now() <= 60000);
ok("C6 conectado: número e data lidos; formatado para a tela", s("owner-connected")?.status === "connected" && wa.formatConnectedPhone(s("owner-connected").phone) === "(11) 98765-4321" && !!s("owner-connected").connectedAt);
ok("C7 sem QR: resposta {qr:null} vira 'sem QR' na tela", wa.parseQr(by["owner-qr-sem-qr"]) === null);
ok("C8 sem sinal do worker: banco devolve 'stale', tela não oferece envio", s("owner-stale")?.status === "stale" && s("owner-stale").canSend === false);
ok("C9 erro: motivo técnico visível para owner", s("owner-error")?.status === "error" && s("owner-error").lastError === "Sessão aberta em outro lugar.");
ok("C10 desconectar devolve disconnect_requested", by["owner-desconectar"]?.status === "disconnect_requested");
const p = s("profissional-error");
ok("C11 profissional: lê o status, sem gestão, sem QR, sem motivo técnico", p?.status === "disconnect_requested" && !p.canManage && !p.qrAvailable && p.lastError === null);
ok("C12 profissional pedindo o QR: o banco recusa (42501), a tela classifica como 'só a administração'", process.argv[3] === "42501" && wa.classifyRpcError({ code: "42501" }) === "forbidden");
ok("C13 todas as respostas de status reais passam pela leitura da tela", rows.filter((r) => r.kind === "status").every((r) => wa.parseStatus(r.json) !== null));
console.log(`RESULTADO contrato W3: PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
NODE
rc=$?
dropdb --force "$DB"
exit $rc
