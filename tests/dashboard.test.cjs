// Dashboard — definição do indicador "Próximos atendimentos".
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const d = load("lib/hive/dashboard.ts");
const NOW = new Date("2026-10-15T15:00:00Z");
const at = (h) => new Date(NOW.getTime() + h * 3600e3).toISOString();

test("próximos: só agendado/confirmado, a partir de agora, até 7 dias", () => {
  assert.equal(d.isUpcoming({ status: "agendado", scheduled_start: at(1) }, NOW), true);
  assert.equal(d.isUpcoming({ status: "confirmado", scheduled_start: at(24 * 6.9) }, NOW), true);
});

test("próximos: NÃO conta cancelado, concluído, falta, em atendimento, passado nem além de 7 dias", () => {
  for (const status of ["cancelado", "concluido", "nao_compareceu", "em_atendimento"]) {
    assert.equal(d.isUpcoming({ status, scheduled_start: at(2) }, NOW), false, status);
  }
  assert.equal(d.isUpcoming({ status: "agendado", scheduled_start: at(-0.5) }, NOW), false, "já começou");
  assert.equal(d.isUpcoming({ status: "agendado", scheduled_start: at(0) }, NOW), false, "começando agora");
  assert.equal(d.isUpcoming({ status: "agendado", scheduled_start: at(24 * 7 + 1) }, NOW), false, "além de 7 dias");
});

test("janela da consulta = mesma regra (de agora até agora + 7 dias)", () => {
  const w = d.upcomingWindow(NOW);
  assert.equal(w.from, NOW.toISOString());
  assert.equal(new Date(w.to).getTime() - NOW.getTime(), 7 * 24 * 3600e3);
  assert.deepEqual([...d.UPCOMING_STATUSES], ["agendado", "confirmado"]);
});
