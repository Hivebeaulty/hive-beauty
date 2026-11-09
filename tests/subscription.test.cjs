// Assinatura vista pela dona — lógica pura (lib/hive/subscription.ts).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const s = load("lib/hive/subscription.ts");

const base = (over = {}) => ({
  status: "active", amount: 59.9, trial_ends_at: "2026-10-08T15:00:00Z", next_payment_at: "2026-12-01T15:00:00Z",
  canceled_at: null, access: { status: "active", allowed: true, warning: false }, can_cancel: true, cancel_pending: false,
  payments: [{ at: "2026-11-01T15:00:00Z", status: "approved", amount: 59.9, refunded: 0 }], ...over,
});

test("parseSubscription: formato válido vira objeto da tela", () => {
  const r = s.parseSubscription(base(), null);
  assert.equal(r.status, "active");
  assert.equal(r.amount, 59.9);
  assert.equal(r.canCancel, true);
  assert.equal(r.access.allowed, true);
  assert.equal(r.payments.length, 1);
});

test("parseSubscription: erro, nulo ou situação desconhecida -> null (tela mostra tentar de novo)", () => {
  assert.equal(s.parseSubscription(null, null), null);
  assert.equal(s.parseSubscription(base(), { message: "x" }), null);
  assert.equal(s.parseSubscription(base({ status: "hackeada" }), null), null);
});

test("parseSubscription: cobranças sem data são descartadas; números em texto viram número", () => {
  const r = s.parseSubscription(base({ amount: "59.90", payments: [{ status: "approved" }, { at: "2026-11-01T15:00:00Z", status: "approved", amount: "59.90", refunded: "0" }] }), null);
  assert.equal(r.amount, 59.9);
  assert.equal(r.payments.length, 1);
  assert.equal(r.payments[0].amount, 59.9);
});

test("parseSubscription: can_cancel só com true explícito", () => {
  assert.equal(s.parseSubscription(base({ can_cancel: "true" }), null).canCancel, false);
});

test("formatDayBR: data no fuso de Brasília", () => {
  assert.equal(s.formatDayBR("2026-12-01T02:00:00Z"), "30/11/2026"); // 23h de 30/11 em Brasília
  assert.equal(s.formatDayBR("2026-12-01T15:00:00Z"), "01/12/2026");
  assert.equal(s.formatDayBR(null), "—");
});

test("describeSubscription: ativa mostra a próxima cobrança e o valor", () => {
  const d = s.describeSubscription(s.parseSubscription(base(), null));
  assert.equal(d.title, "Assinatura ativa");
  assert.match(d.lines[0], /Próxima cobrança de R\$\s59,90 em 01\/12\/2026\./);
  assert.equal(d.canSubscribe, false);
});

test("describeSubscription: teste grátis mostra até quando e quando começa a cobrança", () => {
  const d = s.describeSubscription(s.parseSubscription(base({ status: "trialing", trial_ends_at: "2026-11-15T15:00:00Z", next_payment_at: "2026-11-15T15:00:00Z" }), null));
  assert.equal(d.title, "Teste grátis");
  assert.match(d.lines[0], /até 15\/11\/2026\. Nada é cobrado até lá\./);
  assert.match(d.lines[1], /R\$\s59,90 por mês, a partir de 15\/11\/2026/);
});

test("describeSubscription: cancelada com mês pago (ending) diz até quando continua", () => {
  const d = s.describeSubscription(s.parseSubscription(base({ status: "canceled", can_cancel: false,
    access: { status: "ending", allowed: true, warning: true, until: "2026-12-01T15:00:00Z" } }), null));
  assert.equal(d.title, "Assinatura cancelada");
  assert.match(d.lines[0], /até 01\/12\/2026\. Não haverá novas cobranças\./);
  assert.equal(d.canSubscribe, false);
});

test("describeSubscription: cancelada sem acesso oferece assinar de novo; cortesia e sem assinatura", () => {
  const c = s.describeSubscription(s.parseSubscription(base({ status: "canceled", access: { status: "canceled", allowed: false, warning: false } }), null));
  assert.equal(c.canSubscribe, true);
  assert.equal(s.describeSubscription(s.parseSubscription(base({ status: "free" }), null)).title, "Cortesia");
  assert.equal(s.describeSubscription(s.parseSubscription(base({ status: "none", payments: [] }), null)).canSubscribe, true);
  assert.equal(s.describeSubscription(s.parseSubscription(base({ status: "past_due" }), null)).tone, "warn");
});

test("paymentLabel: rótulos das cobranças", () => {
  assert.equal(s.paymentLabel({ status: "approved", amount: 59.9, refunded: 0 }), "Paga");
  assert.equal(s.paymentLabel({ status: "approved", amount: 59.9, refunded: 20 }), "Paga, com reembolso parcial");
  assert.equal(s.paymentLabel({ status: "scheduled", amount: 59.9, refunded: 0 }), "Agendada");
  assert.equal(s.paymentLabel({ status: "rejected", amount: 59.9, refunded: 0 }), "Recusada");
  assert.equal(s.paymentLabel({ status: "estranho", amount: 59.9, refunded: 0 }), "—");
});

test("cancelWarning: no teste o acesso para na hora; com mês pago, vai até o fim do mês", () => {
  assert.match(s.cancelWarning(s.parseSubscription(base({ status: "trialing" }), null)), /pausado assim que o Mercado Pago confirmar/);
  assert.match(s.cancelWarning(s.parseSubscription(base(), null)), /até o fim do mês que já foi pago/);
});

test("teste sem cartão (provider trial): mostra até quando, sem cobrança, e oferece assinar", () => {
  const d = s.describeSubscription(s.parseSubscription(base({ status: "trialing", provider: "trial", can_cancel: false,
    trial_ends_at: "2026-11-15T15:00:00Z", next_payment_at: null, payments: [],
    access: { status: "trialing", allowed: true, warning: false, until: "2026-11-15T15:00:00Z" } }), null));
  assert.equal(d.title, "Teste grátis, sem cartão");
  assert.match(d.lines[0], /até 15\/11\/2026\. Nada é cobrado\./);
  assert.equal(d.canSubscribe, true);
  const end = s.describeSubscription(s.parseSubscription(base({ status: "trialing", provider: "trial", can_cancel: false,
    access: { status: "trial_ended", allowed: false, warning: false } }), null));
  assert.equal(end.title, "Seu teste grátis terminou");
  assert.equal(end.canSubscribe, true);
  assert.equal(s.parseSubscription(base({ provider: 7 }), null).provider, null);
});
