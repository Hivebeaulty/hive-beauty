// Verificações estáticas da 0015/0016 (o comportamento é testado no banco:
// supabase/tests/0015_auto_conclusion_staging.sql e supabase/tests/local/).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const M15 = read("supabase", "migrations", "0015_auto_conclusion.sql");
const M16 = read("supabase", "migrations", "0016_schedule_auto_conclusion.sql");
const OPS = read("supabase", "operations", "0015_regularizacao_e_ativacao.sql");
const code = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("0015: nenhuma função SECURITY DEFINER e nenhum GRANT para a API", () => {
  assert.ok(!/security\s+definer/i.test(code(M15)));
  assert.ok(!/\bgrant\b[^;]*\bto\b[^;]*(anon|authenticated|service_role|public)/i.test(code(M15)));
  assert.match(M15, /revoke all on all functions in schema aurea_private from public;/);
  assert.match(M15, /foreach r in array array\['anon', 'authenticated', 'service_role'\] loop[\s\S]*revoke all on all functions in schema aurea_private from %I/);
  assert.match(M15, /revoke all on schema aurea_private from public;/);
});

test("0015: todas as funções novas ficam no schema privado e com search_path fixo", () => {
  const fns = [...code(M15).matchAll(/create or replace function\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1]);
  assert.ok(fns.length >= 10);
  for (const f of fns) assert.ok(f.startsWith("aurea_private."), `${f} fora do schema privado`);
  const blocks = code(M15).split(/create or replace function/i).slice(1);
  for (const b of blocks) assert.ok(/set search_path = public, pg_temp/.test(b.split("$$")[0]), "search_path ausente");
});

test("0015: automação nasce DESLIGADA, tolerância de 5 min, sem cron", () => {
  assert.match(M15, /enabled\s+boolean not null default false/);
  assert.match(M15, /grace\s+interval not null default interval '5 minutes'/);
  assert.ok(!/cron\./.test(code(M15)), "0015 não pode mexer no cron");
});

test("0015: só o núcleo cria recebimento, e sempre Pix/pago com origem auto|backfill", () => {
  const inserts = code(M15).match(/insert into payments/gi) || [];
  assert.equal(inserts.length, 1);
  const core = M15.slice(M15.indexOf("aurea_private._conclude_one("), M15.indexOf("-- 7. EXECUÇÃO AGENDADA"));
  assert.match(core, /'pix', 'pago'/);
  assert.match(core, /if p_source not in \('auto', 'backfill'\)/);
});

test("0015: não recria nenhuma função/gatilho/policy de migrations anteriores", () => {
  assert.ok(!/create or replace function\s+(?!aurea_private\.)/i.test(code(M15)));
  assert.ok(!/(drop|alter)\s+(policy|function)\s+(?!aurea_private)/i.test(code(M15)));
  assert.ok(!/drop trigger if exists trg_(?!settings_guard)/i.test(code(M15)));
});

test("0016: agenda a cada 5 min, sem duplicar, chamando só run_auto_conclusion()", () => {
  assert.match(M16, /'\*\/5 \* \* \* \*'/);
  assert.match(M16, /select aurea_private\.run_auto_conclusion\(\)/);
  assert.ok(M16.indexOf("cron.unschedule") < M16.indexOf("cron.schedule("), "remove antes de criar");
  assert.ok(!/\bgrant\b/i.test(code(M16)));
});

test("roteiro operacional: dry run primeiro, IDs e total aprovados", () => {
  assert.ok(OPS.indexOf("aurea_private.regularize());") < OPS.indexOf("p_dry_run        => false"));
  assert.ok(OPS.includes("f077bf3d-5507-441a-8114-b3493ebd640b"));
  assert.ok(OPS.includes("674b1ea5-3bbc-46dd-bd39-2799f0f51a35"));
  assert.ok(OPS.includes("p_expected_total => 250.00"));
});

test("versão de produção dos testes: sem DDL em tabelas de negócio e em sincronia com a completa", () => {
  const FULL = read("supabase", "tests", "0015_auto_conclusion_staging.sql");
  const PROD = read("supabase", "tests", "0015_auto_conclusion_producao_sem_ddl.sql");
  const names = (sql) => [...sql.matchAll(/pg_temp\.t\('([A-Z]\d+[a-z]?) /g)].map((m) => m[1]);
  const full = names(FULL), prod = names(PROD);
  assert.equal(full.length, 88);
  assert.equal(prod.length, 82);
  assert.deepEqual(full.filter((n) => !prod.includes(n)).sort(), ["F1", "F2", "F3", "F4", "K2", "R8"]);
  assert.ok(!/create trigger|alter table|drop trigger|zz_fail|zz_kill/i.test(PROD));
  assert.ok(!/create (or replace )?function (?!pg_temp\.)/i.test(PROD.replace(/\$b\$[\s\S]*?\$b\$/g, "")));
});

test("roteiro de validação: aplica com begin/commit e não cita a 0016 como passo", () => {
  const VAL = read("supabase", "operations", "0015_validacao_supabase.sql");
  assert.match(VAL, /"begin;" na primeira linha/);
  assert.ok(!/0016_schedule_auto_conclusion\.sql/.test(VAL));
  assert.ok(!/regularize\(/.test(VAL) && !/activate_auto_conclusion\(/.test(VAL));
});
