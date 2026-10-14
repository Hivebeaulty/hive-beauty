const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("./load-ts.cjs");
const flow = load("lib/hive/appointment-flow.ts");

const MIGRATION = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "migrations", "0014_appointment_lifecycle_guards.sql"),
  "utf8"
);

test("marcar como pendente só para recebimento recebido (pendente/parcial não)", () => {
  assert.equal(flow.canMarkPaymentPending("pago"), true);
  assert.equal(flow.canMarkPaymentPending("pendente"), false);
  assert.equal(flow.canMarkPaymentPending("parcial"), false);
  assert.equal(flow.canMarkPaymentPending(null), false);
  assert.equal(flow.canMarkPaymentPending(undefined), false);
});

test("erros de 'marcar pendente' viram mensagens específicas", () => {
  assert.match(flow.markPendingErrorMessage("AUR03"), /parcial/);
  assert.match(flow.markPendingErrorMessage("22023"), /concluído/);
  assert.match(flow.markPendingErrorMessage("42501"), /permissão/);
  assert.match(flow.markPendingErrorMessage("P0002"), /não tem recebimento/);
  assert.match(flow.markPendingErrorMessage("28000"), /sessão/);
  assert.match(flow.markPendingErrorMessage("XXXXX"), /Tente novamente/);
});

test("elegibilidade de falta: só 'ok' + eligible=true mostra o botão; o resto é não elegível", () => {
  assert.deepEqual(flow.parseNoShowEligibility({ eligible: true, reason: "ok" }), { eligible: true, reason: "ok" });
  for (const reason of ["not_concluded", "no_payment", "manual", "modified"]) {
    assert.deepEqual(flow.parseNoShowEligibility({ eligible: false, reason }), { eligible: false, reason });
  }
  // respostas estranhas nunca liberam a ação
  assert.equal(flow.parseNoShowEligibility({ eligible: true, reason: "manual" }).eligible, false);
  assert.equal(flow.parseNoShowEligibility({ eligible: true, reason: "???" }).eligible, false);
  assert.equal(flow.parseNoShowEligibility({ eligible: "true", reason: "ok" }).eligible, false);
  assert.equal(flow.parseNoShowEligibility(null).eligible, false);
  assert.equal(flow.parseNoShowEligibility("ok").eligible, false);
  assert.equal(flow.parseNoShowEligibility([{ eligible: true, reason: "ok" }]).eligible, false);
});

test("erros da reclassificação: manual/alterado/já não concluído recarregam a tela", () => {
  assert.deepEqual(flow.noShowErrorMessage("AUR01").reload, true);
  assert.match(flow.noShowErrorMessage("AUR01").message, /manualmente/);
  assert.match(flow.noShowErrorMessage("AUR02").message, /alterado/);
  assert.equal(flow.noShowErrorMessage("22023").reload, true);
  assert.equal(flow.noShowErrorMessage("42501").reload, false);
  assert.match(flow.noShowErrorMessage(undefined).message, /Nada foi alterado/);
});

test("cancelar/falta numa tela desatualizada: 22023 explica e recarrega", () => {
  const r = flow.statusChangeErrorMessage("22023");
  assert.equal(r.reload, true);
  assert.match(r.message, /já foi concluído/);
  assert.equal(flow.statusChangeErrorMessage("28000").reload, false);
  assert.equal(flow.statusChangeErrorMessage(null).reload, true);
});

test("o SQL da 0014 usa exatamente os códigos e motivos que a tela trata", () => {
  for (const code of ["AUR01", "AUR02", "AUR03"]) {
    assert.ok(MIGRATION.includes(`errcode = '${code}'`), `código ${code} ausente no SQL`);
  }
  for (const reason of ["not_concluded", "no_payment", "manual", "modified", "ok"]) {
    assert.ok(MIGRATION.includes(`'reason', '${reason}'`), `motivo ${reason} ausente no SQL`);
  }
  // a guarda do concluído usa 22023, que statusChangeErrorMessage trata
  assert.ok(/appointments_guard_lifecycle[\s\S]*errcode = '22023'/.test(MIGRATION));
});

test("nenhuma função da 0014 cria recebimento (só atualiza ou remove o existente)", () => {
  const fnBodies = MIGRATION.split("create or replace function").slice(1).join("\n");
  assert.ok(!/insert\s+into\s+payments/i.test(fnBodies), "nenhuma função da 0014 deve inserir pagamento");
});
