// Migration 0055 (travas de blocked_times): conteúdo e segurança de reaplicar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "0055_blocked_times_guards.sql"), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("0055: fim depois do início, observação até 200 e índice por empresa e período", () => {
  assert.match(code, /check \(end_at > start_at\)/);
  assert.match(code, /char_length\(reason\) <= 200/);
  assert.match(code, /create index if not exists blocked_times_company_period_idx\s+on blocked_times \(company_id, start_at, end_at\)/);
});

test("0055: só adiciona travas; não apaga nem muda dados ou políticas", () => {
  assert.doesNotMatch(code, /\b(drop|delete|truncate|update|insert)\b/i);
  assert.doesNotMatch(code, /policy/i);
});

test("0055: pode ser aplicada duas vezes (cada trava confere se já existe)", () => {
  assert.equal((code.match(/if not exists \(select 1 from pg_constraint/g) || []).length, 2);
});

test("0055: o limite da observação no banco é o mesmo da tela", () => {
  const { load } = require("./load-ts.cjs");
  assert.equal(load("lib/hive/blocked-times.ts").REASON_MAX, 200);
});
