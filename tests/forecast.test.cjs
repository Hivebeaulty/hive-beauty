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

// ---------------------------------------------------------------------------
// Agenda: período exibido (dia, semana de segunda a domingo, mês do calendário)
// ---------------------------------------------------------------------------
const p = (view, y, m, d) => {
  const { start, end } = f.agendaPeriod(view, new Date(y, m - 1, d));
  return { start, end };
};

test("Agenda, dia: o próprio dia de referência", () => {
  assert.deepEqual(p("dia", 2026, 11, 5), { start: "2026-11-05", end: "2026-11-05" });
  assert.deepEqual(p("dia", 2026, 12, 31), { start: "2026-12-31", end: "2026-12-31" });
});

test("Agenda, semana: segunda a domingo, inclusive quando vira o mês e o ano", () => {
  // quinta 05/11/2026
  assert.deepEqual(p("semana", 2026, 11, 5), { start: "2026-11-02", end: "2026-11-08" });
  // domingo continua na semana que começou na segunda anterior
  assert.deepEqual(p("semana", 2026, 11, 8), { start: "2026-11-02", end: "2026-11-08" });
  // semana que vira o mês (sábado 31/10 -> 26/10 a 01/11)
  assert.deepEqual(p("semana", 2026, 10, 31), { start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(p("semana", 2026, 11, 1), { start: "2026-10-26", end: "2026-11-01" });
  // semana que vira o ano (quinta 31/12/2026 -> 28/12 a 03/01/2027)
  assert.deepEqual(p("semana", 2026, 12, 31), { start: "2026-12-28", end: "2027-01-03" });
});

test("Agenda, semana: mesmos dias da WeekView (getWeekDays)", () => {
  const { getWeekDays } = load("lib/hive/schedule.ts");
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  for (const ref of [new Date(2026, 10, 5), new Date(2026, 9, 31), new Date(2026, 11, 31), new Date(2027, 1, 28)]) {
    const days = getWeekDays(ref);
    assert.deepEqual(f.agendaPeriod("semana", ref).start, fmt(days[0]));
    assert.deepEqual(f.agendaPeriod("semana", ref).end, fmt(days[6]));
  }
});

test("Agenda, mês: só os dias do mês (28, 29, 30 e 31 dias), não os de fora da grade", () => {
  assert.deepEqual(p("mes", 2026, 2, 14), { start: "2026-02-01", end: "2026-02-28" }); // 28
  assert.deepEqual(p("mes", 2028, 2, 10), { start: "2028-02-01", end: "2028-02-29" }); // bissexto
  assert.deepEqual(p("mes", 2026, 11, 5), { start: "2026-11-01", end: "2026-11-30" }); // 30
  assert.deepEqual(p("mes", 2026, 10, 31), { start: "2026-10-01", end: "2026-10-31" }); // 31
  // a grade de novembro/2026 começa em 26/10 e vai até 06/12: esses dias não entram
  const rows = [
    { price: 50, status: "agendado", scheduled_start: "2026-10-30T13:00:00Z" },  // na grade, fora do mês
    { price: 70, status: "agendado", scheduled_start: "2026-11-10T13:00:00Z" },  // no mês
    { price: 90, status: "concluido", scheduled_start: "2026-12-02T13:00:00Z" }, // na grade, fora do mês
  ];
  const nov = f.agendaPeriod("mes", new Date(2026, 10, 5));
  assert.equal(f.forecastFor(rows, nov.start, nov.end).previsto, 70);
});

test("Agenda: limites da consulta no fuso de Brasília e o dia de Brasília nas bordas", () => {
  const nov = f.agendaPeriod("mes", new Date(2026, 10, 5));
  assert.equal(nov.from, "2026-11-01T00:00:00-03:00");
  assert.equal(nov.to, "2026-11-30T23:59:59.999-03:00");
  const day = f.agendaPeriod("dia", new Date(2026, 10, 5));
  assert.equal(day.from, "2026-11-05T00:00:00-03:00");
  assert.equal(day.to, "2026-11-05T23:59:59.999-03:00");
  // 31/10 23h30 em Brasília (= 01/11 02h30 em UTC) é de outubro, não de novembro;
  // 30/11 23h50 em Brasília (= 01/12 02h50 em UTC) ainda é de novembro.
  const rows = [
    { price: 40, status: "agendado", scheduled_start: "2026-11-01T02:30:00Z" },
    { price: 60, status: "confirmado", scheduled_start: "2026-12-01T02:50:00Z" },
    { price: 25, status: "em_atendimento", scheduled_start: "2026-11-01T03:00:00Z" }, // 01/11 00h00 em Brasília
  ];
  assert.deepEqual(f.forecastFor(rows, nov.start, nov.end), { realizado: 0, agendado: 85, previsto: 85, realizados: 0, agendados: 2 });
  const out = f.agendaPeriod("mes", new Date(2026, 9, 15));
  assert.equal(f.forecastFor(rows, out.start, out.end).previsto, 40);
  // e os limites ISO pegam exatamente esses instantes
  const inside = (iso, b) => new Date(iso) >= new Date(b.from) && new Date(iso) <= new Date(b.to);
  assert.equal(inside("2026-11-01T02:30:00Z", nov), false);
  assert.equal(inside("2026-11-01T03:00:00Z", nov), true);
  assert.equal(inside("2026-12-01T02:50:00Z", nov), true);
  assert.equal(inside("2026-12-01T03:00:00Z", nov), false);
});
