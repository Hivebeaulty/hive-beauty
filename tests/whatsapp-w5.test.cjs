// W5 — situação da confirmação automática (lógica pura). As regras reais
// (quem recebe, quando cancela) são testadas no banco: supabase/tests/local/0018_*.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const c = load("lib/hive/whatsapp-confirmation.ts");

test("parseConfirmation: aceita só estados conhecidos; resto (ou 0018 ausente) vira null", () => {
  assert.deepEqual(c.parseConfirmation({ state: "queued", reason: null }), { state: "queued", reason: null });
  assert.deepEqual(c.parseConfirmation({ state: "skipped", reason: "blocked" }), { state: "skipped", reason: "blocked" });
  for (const bad of [null, undefined, "queued", [], {}, { state: "enviado" }, { state: 3 }]) assert.equal(c.parseConfirmation(bad), null);
});

test("sem registro (none) ou dado inválido: a tela fica exatamente como antes (null)", () => {
  assert.equal(c.describeConfirmation(null), null);
  assert.equal(c.describeConfirmation({ state: "none", reason: null }), null);
});

test("enfileirada/enviando/enviada/entregue/lida: o sistema cuida — SEM wa.me (evita mensagem em dobro)", () => {
  for (const state of ["queued", "sending", "retrying", "sent", "delivered", "read"]) {
    const v = c.describeConfirmation({ state, reason: null });
    assert.equal(v.autoHandled, true, state);
    assert.equal(v.allowManual, false, state);
  }
  assert.equal(c.describeConfirmation({ state: "sent", reason: null }).tone, "success");
  assert.equal(c.describeConfirmation({ state: "queued", reason: null }).label, "Confirmação na fila");
});

test("cliente pediu para sair (bloqueada na criação ou cancelada na fila): nenhum caminho de envio, nem manual", () => {
  for (const x of [{ state: "skipped", reason: "blocked" }, { state: "canceled", reason: "recipient_blocked" }]) {
    const v = c.describeConfirmation(x);
    assert.equal(v.autoHandled, false);
    assert.equal(v.allowManual, false);
    assert.match(v.detail, /pediu para não receber/);
  }
});

test("desconectado / desligado / limite / erro / falha: explica e mantém o envio manual", () => {
  for (const reason of ["not_connected", "disabled", "rate_limited", "error"]) {
    const v = c.describeConfirmation({ state: "skipped", reason });
    assert.equal(v.autoHandled, false, reason);
    assert.equal(v.allowManual, true, reason);
  }
  const f = c.describeConfirmation({ state: "failed", reason: null });
  assert.equal(f.tone, "danger"); assert.equal(f.allowManual, true);
  const nw = c.describeConfirmation({ state: "failed", reason: "no_whatsapp" });
  assert.equal(nw.allowManual, false, "número sem WhatsApp: wa.me também não abriria conversa");
  assert.match(c.describeConfirmation({ state: "canceled", reason: "appointment_changed" }).detail, /mudou/);
});

test("sem telefone / inválido / fixo / arquivada: nada novo (a tela já explica pelo telefone)", () => {
  for (const reason of ["no_phone", "invalid_phone", "landline", "archived", "no_client"]) {
    assert.equal(c.describeConfirmation({ state: "skipped", reason }), null, reason);
  }
});

test("textos não expõem telefone nem conteúdo da mensagem", () => {
  const states = ["queued", "sending", "retrying", "sent", "delivered", "read", "failed", "canceled", "skipped"];
  const reasons = [null, "blocked", "recipient_blocked", "not_connected", "disabled", "rate_limited", "error", "no_whatsapp", "appointment_changed"];
  for (const state of states) for (const reason of reasons) {
    const v = c.describeConfirmation({ state, reason });
    if (v) assert.doesNotMatch(`${v.label} ${v.detail ?? ""}`, /\d{8,}/);
  }
});
