// SuperAdmin — assinaturas sem dona (0045).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const u = load("lib/hive/admin-unlinked.ts");

test("lê a lista; valores numéricos em texto viram número", () => {
  const r = u.parseUnlinked([{ preapproval_id: "P1", mp_status: "authorized", amount: "59.90", date_created: "2026-10-25T17:13:00Z", first_seen: "2026-10-25T17:20:00Z", linked_email: null, linked_at: null }]);
  assert.equal(r.length, 1); assert.equal(r[0].amount, 59.9); assert.equal(r[0].linked_email, null);
});
test("falha fechada: formato inesperado -> null", () => {
  assert.equal(u.parseUnlinked(null), null);
  assert.equal(u.parseUnlinked({}), null);
  assert.equal(u.parseUnlinked([{ mp_status: "x" }]), null);
  assert.deepEqual(u.parseUnlinked([]), []);
});
test("valida e-mail e motivo antes de chamar o banco", () => {
  assert.equal(u.validateLink("sem-arroba", "Cliente confirmou"), "Confira o e-mail digitado.");
  assert.match(u.validateLink("a@x.com", "abc"), /pelo menos 5/);
  assert.match(u.validateLink("a@x.com", "x".repeat(501)), /até 500/);
  assert.equal(u.validateLink(" a@x.com ", "Cliente confirmou por WhatsApp"), null);
});
test("mensagens de erro do banco", () => {
  assert.match(u.linkError({ code: "AUA01" }), /duas etapas/);
  assert.match(u.linkError({ code: "P0002" }), /já foi resolvida/);
  assert.equal(u.linkError({ code: "22023", message: "E-mail inválido." }), "E-mail inválido.");
  assert.match(u.linkError({ code: "XX" }), /Não foi possível/);
  assert.equal(u.linkError(null), "");
});
