const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const rk = load("lib/hive/rankings.ts");
const ar = load("lib/hive/auth-recovery.ts");

const row = (o) => ({ id: "a" + Math.random(), scheduled_start: "2026-10-10T13:00:00Z", scheduled_end: "2026-10-10T14:00:00Z",
  price: 50, client_id: "c1", service_id: "s1", clients: { name: "Ana" }, services: { name: "Manicure" }, ...o });

test("rankings: valor = preço final gravado no atendimento concluído (mesma base do Financeiro)", () => {
  assert.equal(rk.appointmentValue(row({ price: "80.5" })), 80.5);
  assert.equal(rk.appointmentValue(row({ price: 90 })), 90);
  assert.equal(rk.appointmentValue(row({ price: null })), 0);
});

test("rankings: serviços (realizados, faturamento, ticket médio, R$/hora) e clientes (visitas, gasto, última visita)", () => {
  const rows = [
    row({ service_id: "s1", services: { name: "Manicure" }, client_id: "c1", price: 50 }),
    row({ service_id: "s1", services: { name: "Manicure" }, client_id: "c2", clients: { name: "Bia" }, price: 50, scheduled_start: "2026-10-12T13:00:00Z", scheduled_end: "2026-10-12T14:00:00Z" }),
    row({ service_id: "s2", services: [{ name: "Gel" }], client_id: "c1", price: 180, scheduled_start: "2026-10-15T13:00:00Z", scheduled_end: "2026-10-15T16:00:00Z" }),
  ];
  const { services, clients } = rk.buildRankings(rows);
  const s1 = services.find((s) => s.id === "s1"), s2 = services.find((s) => s.id === "s2");
  assert.deepEqual([s1.count, s1.revenue, s1.avgTicket, s1.revenuePerHour], [2, 100, 50, 50]);
  assert.deepEqual([s2.count, s2.revenue, s2.revenuePerHour, s2.name], [1, 180, 60, "Gel"]);
  assert.deepEqual(rk.topBy(services, "count").map((s) => s.id), ["s1", "s2"], "mais realizados");
  assert.deepEqual(rk.topBy(services, "revenue").map((s) => s.id), ["s2", "s1"], "mais faturam");
  const c1 = clients.find((c) => c.id === "c1");
  assert.deepEqual([c1.visits, c1.revenue, c1.lastVisit], [2, 230, "2026-10-15T13:00:00Z"]);
  assert.deepEqual(rk.topBy(clients, "revenue").map((c) => c.name), ["Ana", "Bia"]);
  assert.equal(rk.topBy(services, "count", 1).length, 1);
  assert.deepEqual(rk.buildRankings([]), { services: [], clients: [] });
});

test("recuperação: lê os três formatos de link do Supabase", () => {
  assert.deepEqual(ar.parseRecoveryLink("?token_hash=abc&type=recovery", ""), { kind: "token_hash", tokenHash: "abc" });
  assert.deepEqual(ar.parseRecoveryLink("?code=xyz", ""), { kind: "code", code: "xyz" });
  assert.match(ar.parseRecoveryLink("", "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired").message, /expirou/);
  assert.equal(ar.parseRecoveryLink("?error=access_denied&error_description=bad", "").kind, "error");
  assert.deepEqual(ar.parseRecoveryLink("", ""), { kind: "none" });
  assert.equal(ar.parseRecoveryLink("?token_hash=abc&type=signup", "").kind, "none", "outro tipo de link não serve para trocar senha");
});

test("recuperação: regras da nova senha e mensagem que NUNCA revela se o e-mail existe", () => {
  assert.match(ar.passwordProblem("1234567", "1234567"), /pelo menos 8/);
  assert.match(ar.passwordProblem("12345678", "12345679"), /não são iguais/);
  assert.equal(ar.passwordProblem("senha-forte-1", "senha-forte-1"), null);
  const okMsg = ar.resetRequestMessage(null);
  assert.equal(okMsg.ok, true);
  assert.equal(ar.resetRequestMessage({ status: 400, message: "User not found" }).text, okMsg.text, "e-mail inexistente: mesma resposta");
  assert.match(ar.resetRequestMessage({ status: 429, message: "rate limit" }).text, /Muitos pedidos/);
});
