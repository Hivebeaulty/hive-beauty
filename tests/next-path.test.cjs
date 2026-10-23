// Volta depois do login (?next=): só caminhos deste site.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const n = load("lib/hive/next-path.ts");

test("volta para a página pedida", () => {
  assert.equal(n.safeNextPath("/admin"), "/admin");
  assert.equal(n.safeNextPath("/admin/profissionais?assinatura=trialing"), "/admin/profissionais?assinatura=trialing");
  assert.equal(n.safeNextPath("/clientes/123#historico"), "/clientes/123#historico");
});

test("sem destino ou destino inválido: início", () => {
  for (const v of [null, undefined, "", "admin", "x".repeat(600), "%E0%A4%A"]) assert.equal(n.safeNextPath(v), "/inicio", String(v));
});

test("nunca leva para outro site (redirecionamento aberto)", () => {
  for (const v of [
    "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/javascript:alert(1)",
    "%2F%2Fevil.com", "/%2F%2Fevil.com".replace("/%2F", "%2F"), "/\tevil", "/\nevil", "\\\\evil.com", " /admin",
  ]) {
    assert.equal(n.safeNextPath(v), "/inicio", JSON.stringify(v));
  }
});

test("telas de autenticação não viram destino (sem voltar ao login)", () => {
  for (const v of ["/login", "/login?next=/admin", "/cadastro", "/esqueci-senha", "/redefinir-senha?token_hash=x"]) {
    assert.equal(n.safeNextPath(v), "/inicio", v);
  }
  assert.equal(n.safeNextPath("/loginho"), "/loginho"); // só a rota exata ou subrotas
});

test("middleware: só pede retorno quando há para onde voltar", () => {
  assert.equal(n.nextParamFor("/admin", ""), "/admin");
  assert.equal(n.nextParamFor("/admin/profissionais", "?q=ana"), "/admin/profissionais?q=ana");
  assert.equal(n.nextParamFor("/", ""), null);
  assert.equal(n.nextParamFor("/inicio", ""), null);
  assert.equal(n.nextParamFor("//evil.com", ""), null);
});
