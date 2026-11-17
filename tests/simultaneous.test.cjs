// Mais de uma cliente no mesmo horário — lógica pura da tela. A autoridade é o banco (0053):
// supabase/tests/local/0053_local.sh testa o gatilho, a preferência, as permissões e a reversão.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { load } = require("./load-ts.cjs");
const s = load("lib/hive/simultaneous.ts");

const at = (h, m = 0) => new Date(2026, 10, 20, h, m).toISOString();
const row = (id, h1, h2, status = "agendado", name = id) => ({
  id, scheduled_start: at(h1), scheduled_end: at(h2), status, clients: { name },
});

test("só o código AOV01 pede a confirmação", () => {
  assert.equal(s.needsOverlapConfirmation("AOV01"), true);
  for (const c of ["23P01", "AUE02", "", null, undefined]) assert.equal(s.needsOverlapConfirmation(c), false, String(c));
});

test("acha quem se sobrepõe, com o mesmo critério do banco", () => {
  const rows = [row("a", 10, 11, "agendado", "Ana"), row("b", 11, 12, "agendado", "Bia"), row("c", 9, 10, "agendado", "Cida")];
  const found = s.findOverlaps(rows, new Date(at(10, 30)), new Date(at(11, 30)));
  assert.deepEqual(found.map((f) => f.clientName), ["Ana", "Bia"]);
  // encostar não é sobrepor (10h–11h e 11h–12h)
  assert.deepEqual(s.findOverlaps(rows, new Date(at(12)), new Date(at(13))), []);
  assert.deepEqual(s.findOverlaps(rows, new Date(at(11)), new Date(at(12))).map((f) => f.clientName), ["Bia"]);
});

test("cancelado e não compareceu não contam; o próprio atendimento é ignorado na edição", () => {
  const rows = [row("a", 10, 11, "cancelado", "Ana"), row("b", 10, 11, "nao_compareceu", "Bia"), row("c", 10, 11, "confirmado", "Cida")];
  assert.deepEqual(s.findOverlaps(rows, new Date(at(10)), new Date(at(11))).map((f) => f.clientName), ["Cida"]);
  assert.deepEqual(s.findOverlaps(rows, new Date(at(10)), new Date(at(11)), "c"), []);
});

test("a pergunta cita quem já está no horário e a cliente nova", () => {
  const one = s.overlapQuestion([{ id: "a", clientName: "Maria", start: new Date(at(14)) }], "Joana");
  assert.equal(one.title, "Já tem cliente nesse horário");
  assert.equal(one.body, "Você já tem Maria às 14h. Quer agendar Joana também nesse horário?");
  const two = s.overlapQuestion(
    [{ id: "a", clientName: "Maria", start: new Date(at(14)) }, { id: "b", clientName: "Bia", start: new Date(at(14, 30)) }],
    "Joana"
  );
  assert.equal(two.body, "Você já tem Maria às 14h e Bia às 14h30. Quer agendar Joana também nesse horário?");
  assert.match(s.overlapQuestion([], "").body, /Quer agendar essa cliente também\?/);
});

test("o texto não usa jargão nem emoji", () => {
  const q = s.overlapQuestion([{ id: "a", clientName: "Maria", start: new Date(at(9)) }], "Joana");
  for (const t of [q.title, q.body, s.OCCUPIED_SLOT_HINT]) assert.doesNotMatch(t, /conflito|overlap|sobreposi|[\u{1F300}-\u{1FAFF}]/iu, t);
});

test("grade de horários: getAvailableSlots segue devolvendo só os livres (compatibilidade)", () => {
  const src = fs.readFileSync("lib/hive/schedule.ts", "utf8");
  assert.match(src, /export async function getSlotGrid/);
  assert.match(src, /export async function getAvailableSlots[\s\S]*filter\(\(s\) => !s\.occupied\)/);
  // bloqueio de agenda nunca vira horário "ocupado" escolhível
  assert.match(src, /if \(blocked\) continue;/);
});

test("o app só envia a confirmação quando a profissional disse sim (compatível com o banco antigo)", () => {
  for (const f of ["app/(app)/agenda/novo/page.tsx", "app/(app)/agenda/[id]/editar/page.tsx"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /allowOverlap \? \{ (p_allow_overlap|overlap_ok): true \} : \{\}/, f);
    assert.match(src, /needsOverlapConfirmation/, f);
    assert.match(src, /SimultaneousDialog/, f);
  }
});

test("a migration 0053 é opcional e desligada por padrão", () => {
  const sql = fs.readFileSync("supabase/migrations/0053_simultaneous_appointments.sql", "utf8");
  assert.match(sql, /allow_simultaneous boolean not null default false/);
  assert.match(sql, /overlap_ok boolean not null default false/);
  assert.match(sql, /p_allow_overlap boolean default false/);
});
