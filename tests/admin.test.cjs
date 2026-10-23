// SuperAdmin (0038): regras puras das telas. A segurança é testada no banco
// (supabase/tests/local/0038_local.sh); aqui, que a tela nunca "abre" por engano
// e que períodos, filtros e CSV saem certos.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const a = load("lib/hive/admin.ts");

test("whoami: só libera superadmin com MFA; qualquer coisa estranha fecha", () => {
  assert.deepEqual(a.parseWhoami({ is_superadmin: true, mfa_ok: true }), { isSuperadmin: true, mfaOk: true });
  assert.deepEqual(a.parseWhoami({ is_superadmin: true, mfa_ok: false }), { isSuperadmin: true, mfaOk: false });
  assert.deepEqual(a.parseWhoami({ is_superadmin: false, mfa_ok: true }), { isSuperadmin: false, mfaOk: false });
  for (const d of [null, undefined, "true", 1, {}, { is_superadmin: "true", mfa_ok: true }]) {
    assert.deepEqual(a.parseWhoami(d), { isSuperadmin: false, mfaOk: false }, JSON.stringify(d));
  }
});

// sexta, 23/10/2026 01:30 em Brasília = 04:30 UTC (já é "amanhã" em UTC à noite de quinta)
const NOW = new Date("2026-10-23T04:30:00Z");

test("períodos começam à meia-noite de Brasília, não de UTC", () => {
  assert.equal(a.resolvePeriod("hoje", NOW).from.toISOString(), "2026-10-23T03:00:00.000Z");
  assert.equal(a.resolvePeriod("mes", NOW).from.toISOString(), "2026-10-01T03:00:00.000Z");
  assert.equal(a.resolvePeriod("ano", NOW).from.toISOString(), "2026-01-01T03:00:00.000Z");
  const prev = a.resolvePeriod("mes_anterior", NOW);
  assert.equal(prev.from.toISOString(), "2026-09-01T03:00:00.000Z");
  assert.equal(prev.to.toISOString(), "2026-10-01T03:00:00.000Z");
  assert.equal(a.resolvePeriod("mes_anterior", new Date("2026-01-10T15:00:00Z")).from.toISOString(), "2025-12-01T03:00:00.000Z");
  assert.equal(a.resolvePeriod("7d", NOW).to.getTime(), NOW.getTime());
});

test("período personalizado inclui o último dia inteiro; inválido cai em 30 dias", () => {
  const p = a.resolvePeriod("custom", NOW, { de: "2026-10-01", ate: "2026-10-15" });
  assert.equal(p.from.toISOString(), "2026-10-01T03:00:00.000Z");
  assert.equal(p.to.toISOString(), "2026-10-16T03:00:00.000Z");
  assert.equal(p.label, "01/10/2026 a 15/10/2026");
  for (const c of [{ de: "2026-10-15", ate: "2026-10-01" }, { de: "x", ate: "2026-10-01" }, { de: "2020-01-01", ate: "2026-10-01" }, {}]) {
    assert.equal(a.resolvePeriod("custom", NOW, c).key, "30d", JSON.stringify(c));
  }
  assert.equal(a.resolvePeriod("qualquer", NOW).key, "30d");
});

test("variação entre períodos: sem base anterior não inventa porcentagem", () => {
  assert.equal(a.pctChange(3, 0), null);
  assert.equal(a.pctChange(3, 2), 50);
  assert.equal(a.pctChange(1, 4), -75);
});

test("filtros da lista: só valores conhecidos passam; datas no fuso do negócio", () => {
  const f = a.parseAccountFilters({ q: "  Ana ", assinatura: "active", situacao: "suspensas", de: "2026-10-01", ate: "2026-10-31", ordem: "name_asc", pagina: "3", demo: "1" });
  assert.deepEqual(f, { q: "Ana", assinatura: "active", situacao: "suspensas", de: "2026-10-01", ate: "2026-10-31", ordem: "name_asc", pagina: 3, demo: true });
  assert.deepEqual(a.accountFiltersToRpc(f), {
    p_search: "Ana", p_billing: "active", p_suspended: true,
    p_from: "2026-10-01T03:00:00.000Z", p_to: "2026-11-01T03:00:00.000Z", p_include_demo: true,
  });
  const bad = a.parseAccountFilters({ assinatura: "vip", situacao: "x", de: "ontem", ordem: "drop table", pagina: "-5" });
  assert.deepEqual(bad, { q: "", assinatura: "", situacao: "", de: "", ate: "", ordem: "created_desc", pagina: 1, demo: false });
  assert.equal(a.accountFiltersToRpc(bad).p_suspended, null);
  assert.equal(a.parseAccountFilters({ q: "x".repeat(500) }).q.length, 100);
});

test("query string dos filtros: sem vazios, com página trocada", () => {
  const f = a.parseAccountFilters({ q: "Ana Paula", assinatura: "trialing", pagina: "2" });
  assert.equal(a.accountFiltersQuery(f), "?q=Ana+Paula&assinatura=trialing&pagina=2");
  assert.equal(a.accountFiltersQuery(f, { pagina: 1 }), "?q=Ana+Paula&assinatura=trialing");
  assert.equal(a.accountFiltersQuery(a.parseAccountFilters({})), "");
});

test("lista do banco: formato estranho vira null (tela mostra erro, não dados falsos)", () => {
  assert.equal(a.parseAccountList(null), null);
  assert.equal(a.parseAccountList({ rows: [] }), null);
  const l = a.parseAccountList({ total: 1, rows: [{ company_id: "c1", company_name: "X", billing_status: "hack", suspended: "true", appointments_count: "7" }, { nada: 1 }] });
  assert.equal(l.rows.length, 1);
  assert.equal(l.rows[0].billing_status, "none");
  assert.equal(l.rows[0].suspended, false);
  assert.equal(l.rows[0].appointments_count, 7);
});

test("CSV: abre no Excel em português e neutraliza fórmulas (injeção de CSV)", () => {
  const csv = a.toCsv(["Nome", "Obs"], [["=HYPERLINK(\"x\")", "a;b"], ["+5511", "linha\nnova"], ["@soma", "-1"], ["Ana", 3]]);
  assert.ok(csv.startsWith("\uFEFF"), "BOM para acentos no Excel");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "Nome;Obs");
  assert.equal(lines[1], "\"'=HYPERLINK(\"\"x\"\")\";\"a;b\"");
  assert.equal(lines[2], "'+5511;\"linha\nnova\"".split("\r\n")[0]);
  assert.match(csv, /'@soma;'-1/);
  assert.match(csv, /Ana;3/);
});

test("CSV de contas: colunas fixas, rótulos em português, sem dados de clientes finais", () => {
  const csv = a.accountsCsv([{
    company_id: "c1", company_name: "Studio Alfa", is_demo: false, created_at: "2026-10-01T15:00:00Z",
    owner_name: "Ana", owner_email: "ana@x.com", owner_last_sign_in: null, billing_status: "active",
    billing_provider: "mercadopago", next_payment_at: null, suspended: false, appointments_count: 4,
    clients_count: 10, services_count: 3, last_activity_at: null, whatsapp_status: "connected",
  }]);
  const [head, row] = csv.slice(1).trim().split("\r\n");
  assert.equal(head.split(";").length, 13);
  assert.match(row, /^Studio Alfa;Ana;ana@x\.com;01\/10\/2026;—;Pagante;—;não;4;10;3;—;connected$/);
});

test("ativação e rótulos", () => {
  assert.deepEqual(a.activationSteps({ services: 2, clients: 0, appointments_total: 0 }).map((s) => s.done), [true, false, false]);
  assert.equal(a.monthLabel("2026-10"), "out/26");
  assert.equal(a.auditLabel("suspend", "noop"), "Suspendeu o acesso (já estava assim)");
  assert.equal(a.auditLabel("desconhecida"), "desconhecida");
  assert.equal(a.fmtDate(null), "—");
  assert.equal(a.fmtDate("2026-10-23T02:30:00Z"), "22/10/2026"); // ainda é dia 22 em Brasília
});
