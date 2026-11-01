// Previsão de faturamento — lógica pura (lib/hive/forecast.ts).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const f = load("lib/hive/forecast.ts");

// horários em UTC; Brasília = UTC-3
const rows = [
  { price: 100, status: "concluido", scheduled_start: "2026-10-05T13:00:00Z" },      // 05/10
  { price: "80.50", status: "agendado", scheduled_start: "2026-10-05T20:00:00Z" },   // 05/10
  { price: 60, status: "confirmado", scheduled_start: "2026-10-06T12:00:00Z" },      // 06/10
  { price: 40, status: "em_atendimento", scheduled_start: "2026-10-06T15:00:00Z" },  // 06/10
  { price: 999, status: "cancelado", scheduled_start: "2026-10-05T14:00:00Z" },
  { price: 999, status: "nao_compareceu", scheduled_start: "2026-10-05T15:00:00Z" },
  { price: 70, status: "agendado", scheduled_start: "2026-10-08T02:30:00Z" },        // 07/10 23:30 em Brasília
];

test("previsto = concluídos + em aberto; cancelados e faltas ficam de fora", () => {
  assert.deepEqual(f.forecastFor(rows, "2026-10-05", "2026-10-05"), { realizado: 100, agendado: 80.5, previsto: 180.5, realizados: 1, agendados: 1 });
  assert.deepEqual(f.forecastFor(rows, "2026-10-01", "2026-10-31"), { realizado: 100, agendado: 250.5, previsto: 350.5, realizados: 1, agendados: 4 });
});

test("o dia é o de Brasília (23h30 de 07/10 não vira 08/10)", () => {
  assert.equal(f.forecastFor(rows, "2026-10-07", "2026-10-07").agendado, 70);
  assert.equal(f.forecastFor(rows, "2026-10-08", "2026-10-08").previsto, 0);
});

test("sem atendimentos: tudo zero", () => {
  assert.deepEqual(f.forecastFor([], "2026-10-01", "2026-10-31"), { realizado: 0, agendado: 0, previsto: 0, realizados: 0, agendados: 0 });
});

test("centavos sem erro de arredondamento", () => {
  const r = [0.1, 0.2, 0.3].map((p) => ({ price: p, status: "agendado", scheduled_start: "2026-10-05T13:00:00Z" }));
  assert.equal(f.forecastFor(r, "2026-10-05", "2026-10-05").previsto, 0.6);
});

test("hoje, semana (segunda a domingo) e mês", () => {
  const r = f.forecastRanges(new Date(2026, 9, 31, 10)); // sábado 31/10/2026
  assert.deepEqual(r.hoje, { start: "2026-10-31", end: "2026-10-31" });
  assert.deepEqual(r.semana, { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(r.mes, { start: "2026-10-01", end: "2026-10-31" });
});

test("a janela cobre a semana que vira o mês", () => {
  assert.deepEqual(f.forecastWindow(new Date(2026, 9, 31, 10)), { start: "2026-10-01", end: "2026-11-01" });
  assert.deepEqual(f.forecastWindow(new Date(2026, 10, 2, 10)), { start: "2026-11-01", end: "2026-11-30" });
});

test("previsão só para período que ainda não terminou", () => {
  assert.equal(f.periodHasFuture("2026-10-31", "2026-10-31"), true);
  assert.equal(f.periodHasFuture("2026-09-30", "2026-10-31"), false);
});
