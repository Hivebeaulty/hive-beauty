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
  assert.equal(a.LANDING_URL, "https://socia-beauty.lovable.app");
  assert.equal(a.CHECKOUT_URL, "https://mpago.la/2gCWhAH");
});

test("conta suspensa (0038): bloqueia, não oferece assinatura, vale para dona e equipe", () => {
  assert.deepEqual(a.parseAccess({ status: "suspended", allowed: false, warning: false }, null), { status: "suspended", allowed: false, warning: false });
  assert.equal(a.parseAccess({ status: "suspended", allowed: true }, null).allowed, false); // banco e app precisam concordar
  for (const owner of [true, false]) {
    const c = a.accessCopy("suspended", owner);
    assert.equal(c.canSubscribe, false);
    assert.match(c.title, /suspenso/);
    assert.match(c.text, /nada foi apagado/);
  }
});

test("cancelada com mês pago (0041): liberada até a data, com aviso; sem data válida, bloqueia", () => {
  const ok = a.parseAccess({ status: "ending", allowed: true, warning: true, until: "2026-11-20T15:00:00Z" }, null);
  assert.deepEqual(ok, { status: "ending", allowed: true, warning: true, until: "2026-11-20T15:00:00Z" });
  assert.equal(a.formatUntil(ok.until), "20/11/2026");
  assert.deepEqual(a.parseAccess({ status: "ending", allowed: true }, null), { status: "canceled", allowed: false, warning: false });
  assert.deepEqual(a.parseAccess({ status: "ending", allowed: true, until: "amanhã" }, null), { status: "canceled", allowed: false, warning: false });
  assert.equal(a.parseAccess({ status: "ending", allowed: false, until: "2026-11-20T15:00:00Z" }, null).allowed, false);
  assert.equal(a.formatUntil(undefined), "");
});

// --- teste grátis sem cartão (0052) ---------------------------------------------------------
const { parseAccess, accessCopy } = a;
test("teste sem cartão: libera com a data do fim; aviso só quando o banco avisa (últimos 3 dias)", () => {
  const until = "2026-11-15T15:00:00Z";
  const a = parseAccess({ status: "trialing", allowed: true, warning: false, until }, null);
  assert.deepEqual(a, { status: "trialing", allowed: true, warning: false, until });
  const b = parseAccess({ status: "trialing", allowed: true, warning: true, until }, null);
  assert.equal(b.warning, true);
  // teste do Mercado Pago (sem "until") continua como antes: sem aviso e sem data
  assert.deepEqual(parseAccess({ status: "trialing", allowed: true, warning: false }, null), { status: "trialing", allowed: true, warning: false });
  // data inválida não vira aviso
  assert.equal(parseAccess({ status: "trialing", allowed: true, warning: true, until: "ontem" }, null).warning, false);
});

test("teste sem cartão acabou: sem acesso e a dona vê o botão de assinar", () => {
  const a = parseAccess({ status: "trial_ended", allowed: false, warning: false }, null);
  assert.deepEqual(a, { status: "trial_ended", allowed: false, warning: false });
  const own = accessCopy("trial_ended", true);
  assert.equal(own.title, "Seu teste grátis terminou");
  assert.equal(own.canSubscribe, true);
  assert.match(own.text, /R\$ 59,90 por mês/);
  assert.equal(accessCopy("trial_ended", false).canSubscribe, false);
  // "trial_ended" com allowed=true (formato estranho) não libera
  assert.equal(parseAccess({ status: "trial_ended", allowed: true }, null).allowed, false);
});

test("checkoutUrlFor: depois do teste sem cartão usa o link do plano sem teste; nos outros casos, o de sempre", () => {
  const a = load("lib/hive/access.ts");
  assert.equal(a.checkoutUrlFor("trial_ended"), a.CHECKOUT_AFTER_TRIAL_URL);
  assert.equal(a.checkoutUrlFor("trialing", "trial"), a.CHECKOUT_AFTER_TRIAL_URL);
  assert.equal(a.checkoutUrlFor("canceled", "mercadopago"), a.CHECKOUT_URL);
  assert.equal(a.checkoutUrlFor(undefined), a.CHECKOUT_URL);
});
