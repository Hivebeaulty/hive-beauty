// SuperAdmin — Assinaturas e Financeiro (0040): leitura dos números e divisões.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const f = load("lib/hive/admin-finance.ts");

const base = {
  measuring_since: "2026-10-23T16:43:45+00:00", gross_approved: 119.8, refunded: 20, charged_back: 0, received: 99.8,
  fees: 2.99, fees_unknown: 1, net: 56.91, net_unknown: 0, approved_count: 2, paying_subscriptions: 2,
  pending_amount: 59.9, pending_count: 1, rejected_amount: 59.9, rejected_count: 1, mrr_contracted: 119.8, mrr_unknown: 0,
  past_due_now: 0, forecast_30d: 119.8, trials_ending_30d: 1, cohort_trials: 3, cohort_converted: 1, cohort_still_trial: 1,
  churn_base: 1, churn_canceled: 1, trial_canceled: 1, revenue_by_month: [{ month: "2026-11", received: 99.8 }],
};

test("lê a visão financeira; números em texto (numeric do Postgres) viram número", () => {
  const p = f.parseFinance({ ...base, received: "99.80" });
  assert.equal(p.received, 99.8);
  assert.deepEqual(p.revenue_by_month, [{ month: "2026-11", received: 99.8 }]);
});

test("falha FECHADA: campo faltando ou inválido -> null (a tela mostra erro, não números falsos)", () => {
  assert.equal(f.parseFinance(null), null);
  const { received, ...sem } = base;
  assert.equal(f.parseFinance(sem), null);
  assert.equal(f.parseFinance({ ...base, net: "abc" }), null);
  assert.equal(f.parseFinance({ ...base, revenue_by_month: "x" }), null);
});

test("ticket médio, conversão e churn: divisões que não inventam quando não há base", () => {
  const p = f.parseFinance(base);
  assert.equal(f.ticketMedio(p), 49.9);
  assert.equal(f.pct(f.conversionRate(p)), "33,3%");
  assert.equal(f.pct(f.churnRate(p)), "100%");
  const vazio = f.parseFinance({ ...base, paying_subscriptions: 0, cohort_trials: 0, churn_base: 0 });
  assert.equal(f.ticketMedio(vazio), null);
  assert.equal(f.pct(f.conversionRate(vazio)), "—");
  assert.equal(f.pct(f.churnRate(vazio)), "—");
});

test("avisa quando o período começa antes da medição", () => {
  assert.equal(f.startsBeforeMeasuring(new Date("2026-10-01T00:00:00Z"), base.measuring_since), true);
  assert.equal(f.startsBeforeMeasuring(new Date("2026-11-01T00:00:00Z"), base.measuring_since), false);
});

test("rótulos de cobrança e situação; desconhecido não quebra", () => {
  assert.equal(f.paymentLabel("approved"), "Aprovada");
  assert.equal(f.paymentLabel("charged_back"), "Estornada");
  assert.equal(f.paymentLabel("xyz"), "xyz");
  assert.equal(f.paymentTone("xyz"), "muted");
  assert.equal(f.EVENT_LABEL.canceled, "Cancelada");
  assert.equal(f.DEFINITIONS.length, 8);
});

test("erros da função admin-billing em texto claro", () => {
  assert.match(f.billingActionError(403, { code: "AUA01" }), /duas etapas/);
  assert.match(f.billingActionError(403, { code: "42501" }), /permissão/);
  assert.match(f.billingActionError(502, { detail: "MP 400: x" }), /não confirmou.*MP 400/);
  assert.equal(f.billingActionError(400, { error: "Informe o motivo (de 5 a 500 caracteres)." }), "Informe o motivo (de 5 a 500 caracteres).");
  assert.match(f.billingActionError(0, null), /Tente de novo/);
});
