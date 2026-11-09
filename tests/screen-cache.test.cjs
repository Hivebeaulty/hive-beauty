// Memória das telas (desempenho, fase 2) — lib/hive/screen-cache.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const c = load("lib/hive/screen-cache.ts");

test("guarda e devolve o último valor de cada chave", () => {
  c.clearScreenCache();
  assert.equal(c.readScreenCache("inicio:a"), undefined);
  c.writeScreenCache("inicio:a", { n: 1 });
  c.writeScreenCache("inicio:a", { n: 2 });
  assert.deepEqual(c.readScreenCache("inicio:a"), { n: 2 });
});

test("chaves de empresas diferentes não se misturam", () => {
  c.clearScreenCache();
  c.writeScreenCache("clientes:empresa-1", ["Ana"]);
  assert.equal(c.readScreenCache("clientes:empresa-2"), undefined);
});

test("limpar (ao sair da conta) apaga tudo", () => {
  c.writeScreenCache("agenda:x", [1]);
  c.clearScreenCache();
  assert.equal(c.readScreenCache("agenda:x"), undefined);
});

test("mantém só as 40 mais recentes; regravar uma chave a torna recente", () => {
  c.clearScreenCache();
  for (let i = 0; i < 40; i++) c.writeScreenCache(`k${i}`, i);
  c.writeScreenCache("k0", "de novo"); // k0 vira a mais recente
  c.writeScreenCache("k40", 40);       // sai a mais antiga: k1
  assert.equal(c.readScreenCache("k1"), undefined);
  assert.equal(c.readScreenCache("k0"), "de novo");
  assert.equal(c.readScreenCache("k40"), 40);
});
