// SuperAdmin — Aquisição (0041): leitura do funil e taxas entre etapas.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const f = load("lib/hive/admin-funnel.ts");
const base = {
  measuring_since: "2026-10-24T12:00:00+00:00", visitors: 5, pageviews: 7, clickers: 2, cta_clicks: 3, whatsapp_clicks: 1, login_clicks: 0,
  trials_started: 1, first_payments: 0, paying_now: 0,
  by_origin: [{ origin: "instagram", visitors: 4, clickers: 1 }, { origin: "direto", visitors: 1, clickers: 1 }],
  by_device: { mobile: 4, desktop: "1" }, by_cta: { plano: 2, hero: 1 },
  by_campaign: [{ campaign: "lancamento", source: "instagram", visitors: 4, clickers: 1 }],
  by_day: [{ day: "2026-10-24", visitors: 5, clickers: 2 }],
};

test("lê o funil; números em texto viram número", () => {
  const p = f.parseFunnel(base);
  assert.equal(p.visitors, 5);
  assert.equal(p.by_device.desktop, 1);
  assert.equal(p.by_origin[0].origin, "instagram");
});

test("falha FECHADA: campo faltando ou inválido -> null", () => {
  assert.equal(f.parseFunnel(null), null);
  const { visitors, ...sem } = base;
  assert.equal(f.parseFunnel(sem), null);
  assert.equal(f.parseFunnel({ ...base, clickers: "x" }), null);
  assert.equal(f.parseFunnel({ ...base, by_origin: {} }), null);
});

test("etapas: taxa em relação à anterior, sem inventar quando a anterior é zero", () => {
  const s = f.funnelSteps(f.parseFunnel(base));
  assert.deepEqual(s.map((x) => x.value), [5, 2, 1, 0]);
  assert.equal(s[0].rate, null);
  assert.equal(s[1].rate, 0.4);
  assert.equal(s[2].rate, 0.5);
  assert.equal(s[3].rate, 0);
  const z = f.funnelSteps(f.parseFunnel({ ...base, visitors: 0, clickers: 0 }));
  assert.equal(z[1].rate, null);
  assert.equal(z[2].rate, null);
  assert.equal(s[2].source, "Mercado Pago");
});

test("nomes de origem amigáveis; desconhecida aparece como veio", () => {
  assert.equal(f.originLabel("instagram.com"), "Instagram");
  assert.equal(f.originLabel("instagram"), "Instagram");
  assert.match(f.originLabel("direto"), /Direto/);
  assert.equal(f.originLabel("blogdaana.com.br"), "blogdaana.com.br");
});
