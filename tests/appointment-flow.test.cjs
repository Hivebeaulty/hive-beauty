const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const flow = load("lib/hive/appointment-flow.ts");

const START = "2026-10-06T14:00:00Z";
const BEFORE = new Date("2026-10-06T13:59:59Z");
const AT = new Date("2026-10-06T14:00:00Z");
const base = { status: "agendado", scheduledStart: START, professionalMemberId: "m1", role: "owner", memberId: "m9", now: AT };

test("só a partir do horário do atendimento", () => {
  assert.equal(flow.concludeAvailability({ ...base, now: BEFORE }).state, "not_started");
  assert.equal(flow.concludeAvailability({ ...base, now: AT }).state, "available");
  assert.equal(flow.concludeAvailability({ ...base, now: new Date("2026-10-07T10:00:00Z") }).state, "available"); // registro tardio
  const ns = flow.concludeAvailability({ ...base, now: BEFORE });
  assert.equal(ns.startsAt.toISOString(), "2026-10-06T14:00:00.000Z");
});

test("permissão espelha a RPC: owner/admin qualquer; profissional só o seu; reception nenhum", () => {
  assert.equal(flow.concludeAvailability({ ...base, role: "owner" }).state, "available");
  assert.equal(flow.concludeAvailability({ ...base, role: "admin" }).state, "available");
  assert.equal(flow.concludeAvailability({ ...base, role: "professional", memberId: "m1" }).state, "available");
  assert.equal(flow.concludeAvailability({ ...base, role: "professional", memberId: "m2" }).state, "no_permission");
  assert.equal(flow.concludeAvailability({ ...base, role: "reception", memberId: "m1" }).state, "no_permission");
});

test("sem permissão tem prioridade sobre 'ainda não começou'", () => {
  assert.equal(flow.concludeAvailability({ ...base, role: "reception", now: BEFORE }).state, "no_permission");
});

test("status encerrados não permitem registrar; os três 'em aberto' permitem", () => {
  for (const s of ["concluido", "cancelado", "nao_compareceu"]) {
    assert.equal(flow.concludeAvailability({ ...base, status: s }).state, "closed", s);
    assert.equal(flow.isOpenStatus(s), false, s);
    assert.deepEqual(flow.closingActions({ status: s, scheduledStart: START, now: AT }), [], s);
  }
  // confirmado / em_atendimento (legado ou futuro WhatsApp) seguem o mesmo fluxo
  for (const s of ["agendado", "confirmado", "em_atendimento"]) {
    assert.equal(flow.concludeAvailability({ ...base, status: s }).state, "available", s);
  }
});

test("cancelar sempre; 'não compareceu' só depois do horário; nada de Confirmar/Iniciar", () => {
  const before = flow.closingActions({ status: "agendado", scheduledStart: START, now: BEFORE });
  assert.deepEqual(before.map((a) => a.status), ["cancelado"]);
  const after = flow.closingActions({ status: "agendado", scheduledStart: START, now: AT });
  assert.deepEqual(after.map((a) => a.status), ["nao_compareceu", "cancelado"]);
  const all = [...before, ...after].map((a) => a.status);
  assert.ok(!all.includes("confirmado") && !all.includes("em_atendimento"));
});

test("recebido é o padrão; pendente só quando marcado", () => {
  assert.equal(flow.paymentStatusFor(false), "pago");
  assert.equal(flow.paymentStatusFor(true), "pendente");
});

test("erros da RPC viram mensagens específicas e indicam recarregar", () => {
  assert.match(flow.concludeErrorMessage("22023").message, /já foi encerrado/);
  assert.equal(flow.concludeErrorMessage("22023").reload, true);
  assert.match(flow.concludeErrorMessage("23505").message, /Já existe um recebimento/);
  assert.equal(flow.concludeErrorMessage("42501").reload, false);
  assert.match(flow.concludeErrorMessage("42501").message, /permissão/);
  assert.match(flow.concludeErrorMessage("28000").message, /sessão/);
  assert.match(flow.concludeErrorMessage(undefined).message, /Não foi possível/);
  assert.equal(flow.concludeErrorMessage(undefined).reload, true);
});

test("ponto do dia: verde só se TODOS concluídos; cancelados/faltas ignorados", () => {
  assert.equal(flow.dayIndicator([]), "none");
  assert.equal(flow.dayIndicator(["cancelado", "nao_compareceu"]), "none");
  assert.equal(flow.dayIndicator(["concluido"]), "done");
  assert.equal(flow.dayIndicator(["concluido", "concluido", "cancelado"]), "done");
  assert.equal(flow.dayIndicator(["concluido", "agendado"]), "open");
  assert.equal(flow.dayIndicator(["agendado"]), "open");
  assert.equal(flow.dayIndicator(["concluido", "em_atendimento"]), "open");
});
