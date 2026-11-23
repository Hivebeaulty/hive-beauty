// Agenda: dia/visão/profissional na URL (o "Voltar" devolve o dia consultado)
// e eixo de horários de meia em meia hora — lib/hive/agenda-url.ts e timeline-marks.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const u = load("lib/hive/agenda-url.ts");
const m = load("lib/hive/timeline-marks.ts");

const TODAY = new Date(2026, 10, 23, 15, 30); // seg 23/11/2026 15h30, relógio local
const q = (s) => new URLSearchParams(s);
const state = (over = {}) => ({ view: "dia", date: new Date(2026, 10, 23), professional: "all", ...over });

test("sem parâmetros: Dia, hoje, todas as profissionais (a aba Agenda continua caindo em hoje)", () => {
  const s = u.readAgendaState(q(""), TODAY);
  assert.equal(s.view, "dia");
  assert.equal(u.dayParam(s.date), "2026-11-23");
  assert.equal(s.professional, "all");
  assert.equal(s.date.getHours(), 0);
});

test("URL sem contexto do Next (null): cai no padrão", () => {
  assert.equal(u.dayParam(u.readAgendaState(null, TODAY).date), "2026-11-23");
});

test("lê o dia, a visão e a profissional da URL", () => {
  const s = u.readAgendaState(q("data=2026-11-25&visao=semana&prof=abc-123"), TODAY);
  assert.equal(u.dayParam(s.date), "2026-11-25");
  assert.equal(s.view, "semana");
  assert.equal(s.professional, "abc-123");
});

test("valor inválido é ignorado, nunca quebra", () => {
  const s = u.readAgendaState(q("data=2026-02-31&visao=ano&prof=a%20b%3B--"), TODAY);
  assert.equal(u.dayParam(s.date), "2026-11-23");
  assert.equal(s.view, "dia");
  assert.equal(s.professional, "all");
  for (const bad of ["", "ontem", "2026-13-01", "26-11-25", "0050-01-01", "2026-11-5"]) {
    assert.equal(u.parseDayParam(bad), null, bad);
  }
});

test("o dia é do relógio local: 22h não vira o dia seguinte", () => {
  assert.equal(u.dayParam(new Date(2026, 10, 25, 22, 30)), "2026-11-25");
  assert.equal(u.dayParam(new Date(2026, 10, 25, 0, 0)), "2026-11-25");
});

test("ida e volta: o que a tela grava, a tela lê igual", () => {
  const s = state({ view: "dia", date: new Date(2026, 10, 25), professional: "m-2" });
  const back = u.readAgendaState(q(u.writeAgendaSearch("", s, TODAY)), TODAY);
  assert.equal(back.view, "dia");
  assert.equal(u.dayParam(back.date), "2026-11-25");
  assert.equal(back.professional, "m-2");
});

test("só grava o que foge do padrão; hoje deixa a URL limpa", () => {
  assert.equal(u.writeAgendaSearch("", state(), TODAY), "");
  assert.equal(u.writeAgendaSearch("", state({ date: new Date(2026, 10, 25) }), TODAY), "?data=2026-11-25");
  assert.equal(u.writeAgendaSearch("", state({ view: "mes" }), TODAY), "?visao=mes");
  assert.equal(u.writeAgendaSearch("?data=2026-11-25&prof=x", state(), TODAY), "");
});

test("preserva parâmetros de outros assuntos", () => {
  const out = u.writeAgendaSearch("?role=owner&view=agenda", state({ date: new Date(2026, 10, 25) }), TODAY);
  const p = q(out);
  assert.equal(p.get("role"), "owner");
  assert.equal(p.get("view"), "agenda");
  assert.equal(p.get("data"), "2026-11-25");
});

test("eixo de meia em meia hora: 08:00 até 20:00 = 25 marcas", () => {
  const marks = m.timeMarks(8 * 60, 20 * 60);
  assert.equal(marks.length, 25);
  assert.deepEqual(marks.slice(0, 4).map(m.markLabel), ["08:00", "08:30", "09:00", "09:30"]);
  assert.equal(m.markLabel(marks.at(-1)), "20:00");
});

test("eixo acompanha atendimentos fora do horário comum (07:00 a 21:00)", () => {
  const marks = m.timeMarks(7 * 60, 21 * 60);
  assert.equal(marks.length, 29);
  assert.equal(m.markLabel(marks[1]), "07:30");
  assert.equal(m.markLabel(marks.at(-2)), "20:30");
});

test("hora cheia x meia hora (linha do grid mais forte nas horas)", () => {
  assert.equal(m.isFullHour(540), true);
  assert.equal(m.isFullHour(570), false);
  assert.equal(m.MARK_STEP_MIN, 30);
});
