// Verificações estáticas da 0017 (o comportamento é testado no banco:
// supabase/tests/0017_whatsapp_core_staging.sql e supabase/tests/local/0017_*).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const M17 = read("supabase", "migrations", "0017_whatsapp_core.sql");
const T17 = read("supabase", "tests", "0017_whatsapp_core_staging.sql");
const code = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const fnBody = (name) => {
  const i = M17.indexOf(`create or replace function ${name}(`);
  assert.ok(i >= 0, `função ${name} ausente`);
  return M17.slice(i, M17.indexOf("\n$$;", i));
};

test("regra de envio aprovada: 'unknown' recebe; bloqueada, arquivada, sem celular não", () => {
  const rb = fnBody("whatsapp_private.recipient_block");
  assert.match(rb, /archived_at is not null then 'archived'/);
  assert.match(rb, /comm_status = 'blocked' then 'blocked'/);
  assert.match(rb, /<> 13 then 'landline'/);
  assert.ok(!/unknown/.test(rb), "a regra não pode bloquear comm_status 'unknown'");
});

test("nenhum GRANT da 0017 para anon, service_role ou PUBLIC", () => {
  const grants = code(M17).match(/grant[^;]*;/gi) || [];
  for (const g of grants) assert.ok(!/\bto\s+(anon|service_role|public)\b/i.test(g), g);
});

test("toda função nova tem search_path fixo", () => {
  const blocks = code(M17).split(/create or replace function/i).slice(1);
  assert.ok(blocks.length >= 26);
  for (const b of blocks) assert.match(b.split("$$")[0], /set search_path = public, pg_temp/);
});

test("papel do worker nasce SEM login e sem senha no repositório", () => {
  assert.match(M17, /create role wa_worker nologin noinherit/);
  assert.ok(!/password|alter\s+role/i.test(code(M17)), "nada de senha nem alteração de papel na 0017");
});

test("a 0017 não toca na automação (aurea_private) nem recria objetos de migrations anteriores", () => {
  assert.ok(!/aurea_private\./.test(code(M17)));
  assert.ok(!/(drop|alter)\s+(table|function|trigger|policy)\s+(?!if exists trg_)(public\.)?(appointments|payments|clients|aurea_private)/i.test(code(M17)));
  assert.ok(!/cron\./.test(code(M17)), "W1 não agenda nada");
});

test("bateria SQL da 0017 com 61 testes e códigos de erro exatos nos negativos", () => {
  const names = [...T17.matchAll(/pg_temp\.t\('([A-Z]\d+) /g)].map((m) => m[1]);
  assert.equal(names.length, 61);
  assert.equal(new Set(names).size, 61, "nomes repetidos");
  assert.ok(!/'fail'\s*,/.test(T17), "teste negativo sem código exato");
});
