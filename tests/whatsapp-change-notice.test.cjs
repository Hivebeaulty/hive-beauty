// Aviso de remarcação/cancelamento — tradução pura. As regras reais estão no
// banco: supabase/tests/local/0023_notices_local.sh.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const n = load("lib/hive/whatsapp-change-notice.ts");

test("parse: só estados conhecidos; ausente/inválido => null (tela como antes)", () => {
  assert.deepEqual(n.parseChangeNotice({ kind: "cancel", state: "queued" }), { kind: "cancel", state: "queued", reason: null });
  for (const bad of [null, undefined, [], {}, { state: "x" }, "queued"]) assert.equal(n.parseChangeNotice(bad), null);
});

test("na fila / enviado: frase certa para remarcação e cancelamento", () => {
  assert.match(n.describeChangeNotice({ kind: "reschedule", state: "queued", reason: null }, "reschedule").text, /será avisada.*novo horário/);
  assert.match(n.describeChangeNotice({ kind: "cancel", state: "sent", reason: null }, "cancel").text, /foi avisada.*cancelamento/);
  assert.match(n.describeChangeNotice({ kind: "cancel", state: "read", reason: null }, "cancel").text, /foi avisada/);
});

test("aviso de OUTRO tipo, nenhum aviso ou substituído: nada aparece", () => {
  assert.equal(n.describeChangeNotice({ kind: "cancel", state: "queued", reason: null }, "reschedule"), null);
  assert.equal(n.describeChangeNotice({ kind: null, state: "none", reason: null }, "cancel"), null);
  assert.equal(n.describeChangeNotice({ kind: "reschedule", state: "canceled", reason: null }, "reschedule"), null);
  assert.equal(n.describeChangeNotice(null, "cancel"), null);
});

test("motivos de não enviar: claros e nunca sugerem que a mensagem saiu", () => {
  const sk = (reason, kind = "reschedule") => n.describeChangeNotice({ kind, state: "skipped", reason }, kind).text;
  assert.match(sk("confirmation_pending"), /vai com o horário novo/);
  assert.match(sk("confirmation_pending", "cancel"), /nenhuma mensagem será enviada/);
  assert.match(sk("blocked"), /pediu para não receber/);
  assert.match(sk("not_connected"), /desconectado/);
  assert.match(sk("no_phone"), /celular válido/);
  assert.match(sk("rate_limited"), /Não foi possível/);
  for (const r of ["confirmation_pending", "blocked", "not_connected", "disabled", "no_phone", "landline", "error"]) {
    assert.doesNotMatch(sk(r), /foi avisada/);
  }
});
