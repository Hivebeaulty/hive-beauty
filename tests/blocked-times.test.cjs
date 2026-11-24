// Bloqueio de horário na Agenda — lib/hive/blocked-times.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const b = load("lib/hive/blocked-times.ts");

const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const blk = (s, e, reason = null, prof = null) => ({
  id: "x", professional_member_id: prof, start_at: s.toISOString(), end_at: e.toISOString(), reason,
});
const input = (o = {}) => ({ date: "2026-11-25", endDate: "2026-11-25", allDay: false, start: "12:00", end: "13:00", ...o });

test("horário: início e fim no relógio local, no dia escolhido", () => {
  const r = b.blockRange(input());
  assert.equal(r.start.getTime(), L(2026, 11, 25, 12).getTime());
  assert.equal(r.end.getTime(), L(2026, 11, 25, 13).getTime());
});

test("dia todo: da meia-noite do dia à meia-noite do dia seguinte", () => {
  const r = b.blockRange(input({ allDay: true }));
  assert.equal(r.start.getTime(), L(2026, 11, 25).getTime());
  assert.equal(r.end.getTime(), L(2026, 11, 26).getTime());
});

test("vários dias (férias): até o fim do último dia, virando o mês", () => {
  const r = b.blockRange(input({ date: "2026-11-28", endDate: "2026-12-02", allDay: true }));
  assert.equal(r.start.getTime(), L(2026, 11, 28).getTime());
  assert.equal(r.end.getTime(), L(2026, 12, 3).getTime());
});

test("erros em português, sem estourar", () => {
  assert.match(b.blockRange(input({ date: "" })).error, /data do bloqueio/);
  assert.match(b.blockRange(input({ date: "2026-02-31" })).error, /data do bloqueio/);
  assert.match(b.blockRange(input({ start: "", end: "" })).error, /horário inicial e o final/);
  assert.match(b.blockRange(input({ start: "25:00" })).error, /horário inicial e o final/);
  assert.match(b.blockRange(input({ start: "13:00", end: "12:00" })).error, /depois do inicial/);
  assert.match(b.blockRange(input({ start: "12:00", end: "12:00" })).error, /depois do inicial/);
  assert.match(b.blockRange(input({ allDay: true, date: "2026-11-25", endDate: "2026-11-24" })).error, /antes da data inicial/);
});

test("com dia todo, o horário digitado é ignorado (mesmo vazio ou inválido)", () => {
  const r = b.blockRange(input({ allDay: true, start: "", end: "zz" }));
  assert.ok(!r.error);
});

test("observação: apara, junta espaços, vazio vira nulo, limite de 200", () => {
  assert.equal(b.cleanReason("  Folga   da  Ana \n"), "Folga da Ana");
  assert.equal(b.cleanReason("   "), null);
  assert.equal(b.reasonProblem("a".repeat(200)), null);
  assert.match(b.reasonProblem("a".repeat(201)), /até 200/);
});

test("dia todo é reconhecido; horário e meia-noite parcial não", () => {
  assert.equal(b.isAllDay(blk(L(2026, 11, 25), L(2026, 11, 26))), true);
  assert.equal(b.isAllDay(blk(L(2026, 11, 25), L(2026, 11, 28))), true);
  assert.equal(b.isAllDay(blk(L(2026, 11, 25, 12), L(2026, 11, 25, 13))), false);
  assert.equal(b.isAllDay(blk(L(2026, 11, 25), L(2026, 11, 25, 18))), false);
});

test("dias cobertos: um dia, vários, e fim exclusivo", () => {
  assert.deepEqual(b.coveredDays(blk(L(2026, 11, 25), L(2026, 11, 26))), ["2026-11-25"]);
  assert.deepEqual(b.coveredDays(blk(L(2026, 11, 29), L(2026, 12, 2))), ["2026-11-29", "2026-11-30", "2026-12-01"]);
  assert.deepEqual(b.coveredDays(blk(L(2026, 11, 25, 22), L(2026, 11, 26, 2))), ["2026-11-25", "2026-11-26"]);
});

test("recorte no dia (minutos): horário, dia todo, vários dias e fora do dia", () => {
  const day = L(2026, 11, 25);
  assert.deepEqual(b.clipToDay(blk(L(2026, 11, 25, 12), L(2026, 11, 25, 13, 30)), day), { startMin: 720, endMin: 810 });
  assert.deepEqual(b.clipToDay(blk(L(2026, 11, 25), L(2026, 11, 26)), day), { startMin: 0, endMin: 1440 });
  assert.deepEqual(b.clipToDay(blk(L(2026, 11, 24), L(2026, 11, 27)), day), { startMin: 0, endMin: 1440 });
  assert.deepEqual(b.clipToDay(blk(L(2026, 11, 24, 22), L(2026, 11, 25, 7)), day), { startMin: 0, endMin: 420 });
  assert.equal(b.clipToDay(blk(L(2026, 11, 26), L(2026, 11, 27)), day), null);
  assert.equal(b.clipToDay(blk(L(2026, 11, 24), L(2026, 11, 25)), day), null, "termina à meia-noite: não toca o dia");
});

test("bloqueios do dia, em ordem", () => {
  const day = L(2026, 11, 25);
  const list = [blk(L(2026, 11, 25, 15), L(2026, 11, 25, 16)), blk(L(2026, 11, 25, 9), L(2026, 11, 25, 10)), blk(L(2026, 11, 26, 9), L(2026, 11, 26, 10))];
  assert.deepEqual(b.blocksOnDay(list, day).map((x) => new Date(x.start_at).getHours()), [9, 15]);
});

test("coluna da profissional: a dela e os da equipe toda", () => {
  assert.equal(b.appliesToLane({ professional_member_id: null }, "m1"), true);
  assert.equal(b.appliesToLane({ professional_member_id: "m1" }, "m1"), true);
  assert.equal(b.appliesToLane({ professional_member_id: "m2" }, "m1"), false);
  assert.equal(b.appliesToLane({ professional_member_id: "m2" }, null), true, "sem lista de profissionais: mostra todos");
});

test("texto do quando e do quê", () => {
  assert.equal(b.blockWhenText(blk(L(2026, 11, 25), L(2026, 11, 26))), "Dia todo");
  assert.equal(b.blockWhenText(blk(L(2026, 11, 28), L(2026, 12, 3))), "Dia todo · até 02/12");
  assert.equal(b.blockWhenText(blk(L(2026, 11, 25, 9, 5), L(2026, 11, 25, 13))), "09:05–13:00");
  assert.equal(b.blockLabel(blk(L(2026, 11, 25), L(2026, 11, 26), " Folga ")), "Folga");
  assert.equal(b.blockLabel(blk(L(2026, 11, 25), L(2026, 11, 26), "  ")), "Dia bloqueado");
  assert.equal(b.blockLabel(blk(L(2026, 11, 25, 12), L(2026, 11, 25, 13))), "Horário bloqueado");
});

test("mês: só dia inteiro marca o dia", () => {
  const keys = b.allDayKeys([blk(L(2026, 11, 27), L(2026, 11, 29)), blk(L(2026, 11, 25, 12), L(2026, 11, 25, 13))]);
  assert.deepEqual([...keys].sort(), ["2026-11-27", "2026-11-28"]);
});

test("formulário de edição: ida e volta com o que o formulário grava", () => {
  for (const inp of [input(), input({ allDay: true }), input({ allDay: true, date: "2026-11-28", endDate: "2026-12-02" })]) {
    const r = b.blockRange(inp);
    const back = b.blockToForm(blk(r.start, r.end));
    assert.equal(back.representable, true);
    assert.equal(back.allDay, inp.allDay);
    assert.equal(back.date, inp.date);
    if (inp.allDay) assert.equal(back.endDate, inp.endDate);
    else assert.deepEqual([back.start, back.end], [inp.start, inp.end]);
  }
});

test("bloqueio de horário que atravessa a noite não é reescrito pelo formulário", () => {
  assert.equal(b.blockToForm(blk(L(2026, 11, 25, 22), L(2026, 11, 26, 6))).representable, false);
});

test("sobreposição com fim exclusivo", () => {
  assert.equal(b.overlaps(L(2026, 11, 25, 12), L(2026, 11, 25, 13), L(2026, 11, 25, 13), L(2026, 11, 25, 14)), false);
  assert.equal(b.overlaps(L(2026, 11, 25, 12), L(2026, 11, 25, 13, 1), L(2026, 11, 25, 13), L(2026, 11, 25, 14)), true);
});
