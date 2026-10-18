// Edição de agendamento — lógica pura. A autoridade é o banco (0022):
// supabase/tests/local/0022_edit_local.sh testa RLS, conflitos e concorrência.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const e = load("lib/hive/appointment-edit.ts");

const appt = {
  client_id: "c1", service_id: "s1", professional_member_id: "p1",
  scheduled_start: "2026-10-20T13:00:00.000Z", scheduled_end: "2026-10-20T14:30:00.000Z",
  price: 80, status: "agendado", notes: "obs",
};
const form = (o = {}) => ({
  clientId: "c1", serviceId: "s1", professionalId: "p1", start: new Date("2026-10-20T13:00:00.000Z"),
  durationMinutes: 90, price: 80, notes: " obs ", ...o,
});

test("só agendamento em aberto é editável", () => {
  for (const s of ["agendado", "confirmado", "em_atendimento"]) assert.equal(e.canEditAppointment(s), true, s);
  for (const s of ["concluido", "cancelado", "nao_compareceu"]) assert.equal(e.canEditAppointment(s), false, s);
});

test("expected: exatamente o que a tela viu (o banco recusa se mudou)", () => {
  assert.deepEqual(e.expectedFrom(appt), {
    client_id: "c1", service_id: "s1", professional_member_id: "p1",
    scheduled_start: appt.scheduled_start, scheduled_end: appt.scheduled_end, price: 80, status: "agendado",
  });
  assert.equal(e.durationMinutesOf(appt), 90);
});

test("hasChanges: nada mudou (inclusive espaços na observação) => false; cada campo => true", () => {
  assert.equal(e.hasChanges(appt, form()), false);
  for (const o of [{ clientId: "c2" }, { serviceId: "s2" }, { professionalId: "p2" }, { start: new Date("2026-10-20T14:00:00Z") },
                   { durationMinutes: 60 }, { price: 81 }, { notes: "outra" }]) {
    assert.equal(e.hasChanges(appt, form(o)), true, JSON.stringify(o));
  }
});

test("isReschedule: só dia/horário ou serviço contam (é o que a cliente sabe)", () => {
  assert.equal(e.isReschedule(appt, form({ start: new Date("2026-10-21T13:00:00Z") })), true);
  assert.equal(e.isReschedule(appt, form({ serviceId: "s2" })), true);
  for (const o of [{ professionalId: "p2" }, { price: 99 }, { notes: "x" }, { durationMinutes: 60 }, { clientId: "c2" }]) {
    assert.equal(e.isReschedule(appt, form(o)), false, JSON.stringify(o));
  }
});

test("mensagens de erro claras e sem jargão para cada recusa do banco", () => {
  assert.match(e.editErrorMessage("23P01").message, /ocupado/);
  assert.equal(e.editErrorMessage("23P01").reloadSlots, true);
  assert.match(e.editErrorMessage("AUE02").message, /outra pessoa/);
  assert.equal(e.editErrorMessage("AUE02").reload, true);
  assert.match(e.editErrorMessage("AUE01").message, /não está mais em aberto/);
  assert.match(e.editErrorMessage("AUE03").message, /cliente/);
  assert.match(e.editErrorMessage("AUE04").message, /serviço/);
  assert.match(e.editErrorMessage("AUE05").message, /profissional/);
  assert.match(e.editErrorMessage(undefined).message, /Nada foi alterado/);
  for (const c of ["23P01", "AUE01", "AUE02", "AUE03", "AUE04", "AUE05", "AUE06", "P0002", "42501", "28000", "x"]) {
    assert.doesNotMatch(e.editErrorMessage(c).message, /AUE|23P01|constraint|exception/i);
  }
});

test("concluído/retroativo: só dona e administração; retroativo = horário que já passou", () => {
  assert.equal(e.canManageConcluded("owner"), true);
  assert.equal(e.canManageConcluded("admin"), true);
  for (const r of ["professional", "reception", null, undefined]) assert.equal(e.canManageConcluded(r), false, String(r));
  const now = new Date("2026-10-16T15:00:00Z");
  assert.equal(e.isRetroactive(new Date("2026-10-16T14:59:00Z"), now), true);
  assert.equal(e.isRetroactive(new Date("2026-10-16T15:00:00Z"), now), false);
});

test("concluído: conferência inclui o status do recebimento; mensagens claras", () => {
  assert.equal(e.concludedExpectedFrom({ ...appt, status: "concluido" }, "pendente").payment_status, "pendente");
  assert.match(e.concludedErrorMessage("AUR03").message, /parcial/);
  assert.match(e.concludedErrorMessage("AUE06", "Atendimento concluído não pode ficar com horário no futuro.").message, /futuro/);
  assert.match(e.concludedErrorMessage("42501").message, /administração/);
  assert.match(e.concludedErrorMessage("23P01").message, /ocupado/);
});

test("concluído: a conferência inclui a cliente (correção de lançamento recusa se outra pessoa mudou)", () => {
  assert.equal(e.concludedExpectedFrom({ ...appt, status: "concluido" }, "pago").client_id, "c1");
});
