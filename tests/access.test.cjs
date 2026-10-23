// Assinatura (0037): leitura da resposta de get_company_access / get_my_access
// e textos da tela /assinatura.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const a = load("lib/hive/access.ts");

const ok = (status) => ({ status, allowed: ["free", "trialing", "active", "past_due"].includes(status), warning: status === "past_due" });

test("libera cortesia, teste grátis, ativa e atrasada (esta com aviso)", () => {
  for (const s of ["free", "trialing", "active"]) assert.deepEqual(a.parseAccess(ok(s), null), { status: s, allowed: true, warning: false });
  assert.deepEqual(a.parseAccess(ok("past_due"), null), { status: "past_due", allowed: true, warning: true });
});

test("bloqueia sem assinatura, pendente e cancelada", () => {
  for (const s of ["none", "pending", "canceled"]) assert.equal(a.parseAccess(ok(s), null).allowed, false);
});

test("falha FECHADA: erro, vazio ou formato estranho -> sem acesso, status 'error'", () => {
  assert.deepEqual(a.parseAccess(ok("active"), { message: "Não autenticado." }), { status: "error", allowed: false, warning: false });
  for (const d of [null, undefined, "active", 1, {}, { status: "vip", allowed: true }]) {
    assert.equal(a.parseAccess(d, null).allowed, false, JSON.stringify(d));
  }
});

test("as duas regras precisam concordar: allowed=true com status bloqueado não libera, e vice-versa", () => {
  assert.equal(a.parseAccess({ status: "canceled", allowed: true }, null).allowed, false);
  assert.equal(a.parseAccess({ status: "active", allowed: false }, null).allowed, false);
  assert.equal(a.parseAccess({ status: "active", allowed: "true" }, null).allowed, false);
});

test("tela: só a dona vê o botão de assinar; a equipe é orientada a falar com ela", () => {
  for (const s of ["none", "canceled"]) {
    assert.equal(a.accessCopy(s, true).canSubscribe, true);
    assert.equal(a.accessCopy(s, false).canSubscribe, false);
  }
  assert.match(a.accessCopy("none", false).text, /dona/);
});

test("tela: pendente e erro não oferecem nova assinatura (evita cobrança em dobro)", () => {
  assert.equal(a.accessCopy("pending", true).canSubscribe, false);
  assert.equal(a.accessCopy("error", true).canSubscribe, false);
  assert.match(a.accessCopy("error", true).title, /conferir/);
});

test("tela: sempre lembra que os dados continuam guardados quando bloqueia", () => {
  for (const s of ["none", "canceled"]) assert.match(a.accessCopy(s, true).text, /nada foi apagado/);
  assert.match(a.accessCopy("none", false).text, /nada foi apagado/);
});

test("links fixos: landing e checkout", () => {
  assert.equal(a.LANDING_URL, "https://aurea-hivebeauty.lovable.app");
  assert.equal(a.CHECKOUT_URL, "https://mpago.la/2gCWhAH");
});
