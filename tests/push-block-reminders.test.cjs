// Lembrete no celular dos compromissos da agenda (0056): texto do aviso, função de envio,
// opções da tela e a migration. Sem Postgres nem Deno (o banco é testado por supabase/tests/local/0056_local.sh).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("./load-ts.cjs");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const edge = read("supabase/functions/push-appointment-alerts/index.ts");
const sql = read("supabase/migrations/0056_blocked_time_reminders.sql");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const blk = load("lib/hive/blocked-times.ts");

// Executa o trecho REAL da função de envio (minutesLabel + relógio + blockReminderNotification).
function loadNotifier() {
  const { transpileModule, ModuleKind } = require("typescript");
  const minutes = edge.match(/export function minutesLabel[\s\S]*?\n}\n/)[0];
  const clock = edge.match(/const TIME_ZONE = [^\n]*\n/)[0] + edge.match(/const clock = [^\n]*\n/)[0];
  const body = edge.match(/\/\/ --- Texto do lembrete de compromisso[\s\S]*?\n\/\/ -{20,}\n/)[0];
  const js = transpileModule([minutes, clock, body].join("\n"), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const m = { exports: {} };
  new Function("exports", "module", js)(m.exports, m);
  return m.exports.blockReminderNotification;
}
const notify = loadNotifier();
const T = (iso) => iso; // horário de Brasília = UTC-3
const timed = (before, reason = "Almoço") => ({
  id: "b1", start: T("2026-11-25T15:00:00Z"), end: T("2026-11-25T16:00:00Z"), allDay: false, reason, before,
});
const allDay = (before, endIso = "2026-11-26T03:00:00Z", reason = "Folga") => ({
  id: "b2", start: T("2026-11-25T03:00:00Z"), end: endIso, allDay: true, reason, before,
});

test("aviso de horário: antecedência, observação e horário de Brasília", () => {
  assert.deepEqual(notify(timed(30)), { title: "Daqui a 30 min: Almoço", body: "12:00–13:00", url: "/agenda?data=2026-11-25", tag: "block-b1" });
  assert.equal(notify(timed(60)).title, "Daqui a 1 h: Almoço");
  assert.equal(notify(timed(120)).title, "Daqui a 2 h: Almoço");
  assert.equal(notify(timed(0)).title, "Agora: Almoço");
  assert.equal(notify(timed(1440)).title, "Amanhã: Almoço");
});

test("aviso de dia todo: no dia, na véspera e vários dias", () => {
  assert.deepEqual(notify(allDay(-480)), { title: "Hoje: Folga", body: "Dia todo", url: "/agenda?data=2026-11-25", tag: "block-b2" });
  assert.equal(notify(allDay(360)).title, "Amanhã: Folga");
  assert.equal(notify(allDay(360, "2026-11-28T03:00:00Z")).body, "Dia todo · até 27/11");
});

test("observação vazia usa o texto padrão; espaços e tamanho são tratados", () => {
  assert.equal(notify(timed(30, null)).title, "Daqui a 30 min: Horário bloqueado");
  assert.equal(notify(timed(30, "   ")).title, "Daqui a 30 min: Horário bloqueado");
  assert.equal(notify(allDay(-480, undefined, null)).title, "Hoje: Dia bloqueado");
  assert.equal(notify(timed(30, "  Consulta \n  médica  ")).title, "Daqui a 30 min: Consulta médica");
  const long = notify(timed(30, "x".repeat(200))).title.replace("Daqui a 30 min: ", "");
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

test("a data do toque é a de Brasília, não a de UTC (22h30 do dia 25 não vira dia 26)", () => {
  const n = notify({ id: "b3", start: "2026-11-26T01:30:00Z", end: "2026-11-26T02:30:00Z", allDay: false, reason: "Aula", before: 15 });
  assert.equal(n.url, "/agenda?data=2026-11-25");
  assert.equal(n.body, "22:30–23:30");
});

test("a função de envio reserva e envia os lembretes sem derrubar o aviso de atendimento", () => {
  assert.match(edge, /rpc\("push_claim_due_block_reminders"\)/);
  assert.ok(edge.indexOf("push_claim_due_alerts") < edge.indexOf("push_claim_due_block_reminders"), "primeiro o aviso de atendimento");
  const section = edge.slice(edge.indexOf("// 1b)"), edge.indexOf("// 2) Aviso semanal"));
  assert.match(section, /try \{[\s\S]*push_claim_due_block_reminders[\s\S]*\} catch/);
  assert.match(section, /PGRST202/, "0056 ainda não aplicada: segue sem lembrete");
  assert.match(section, /pushTo\(/);
  assert.match(edge, /JSON\.stringify\(\{ \.\.\.appt, blocks, overdue \}\)/);
});

test("opções da tela: horário e dia todo, todas dentro da faixa do banco", () => {
  assert.deepEqual(blk.remindOptions(false).map((o) => o.value), [null, 0, 15, 30, 60, 120, 1440]);
  assert.deepEqual(blk.remindOptions(true).map((o) => o.value), [null, -480, 360]);
  for (const o of [...blk.REMIND_TIMED, ...blk.REMIND_ALL_DAY]) {
    if (o.value !== null) assert.ok(o.value >= blk.REMIND_MIN && o.value <= blk.REMIND_MAX, String(o.value));
  }
  assert.equal(blk.REMIND_MIN, -1440);
  assert.equal(blk.REMIND_MAX, 10080);
});

test("trocar entre horário e dia todo mantém o lembrete só se ele existir no outro tipo", () => {
  assert.equal(blk.remindAfterModeChange(true, 30), null);
  assert.equal(blk.remindAfterModeChange(false, -480), null);
  assert.equal(blk.remindAfterModeChange(true, -480), -480);
  assert.equal(blk.remindAfterModeChange(false, 60), 60);
  assert.equal(blk.remindAfterModeChange(true, null), null);
  assert.equal(blk.isValidRemind(false, 45), false);
  assert.equal(blk.isValidRemind(true, 15), false);
});

test("hora do aviso: início menos a antecedência (negativa = depois do início)", () => {
  const start = "2026-11-25T15:00:00Z";
  assert.equal(blk.remindAt(start, 30).toISOString(), "2026-11-25T14:30:00.000Z");
  assert.equal(blk.remindAt("2026-11-25T03:00:00Z", -480).toISOString(), "2026-11-25T11:00:00.000Z", "no dia, às 8h de Brasília");
  assert.equal(blk.remindAt("2026-11-25T03:00:00Z", 360).toISOString(), "2026-11-24T21:00:00.000Z", "véspera, às 18h de Brasília");
  assert.equal(blk.remindText(false, 30), "30 minutos antes");
  assert.equal(blk.remindText(true, 360), "Na véspera, às 18h");
  assert.equal(blk.remindText(false, null), "");
});

test("a agenda continua lendo só as colunas antigas (funciona antes da 0056)", () => {
  assert.doesNotMatch(blk.BLOCK_SELECT, /remind/);
  assert.match(blk.BLOCK_SELECT_WITH_REMINDER, /remind_before_minutes/);
});

test("0056: coluna opcional, faixa, registro fechado e função só do servidor", () => {
  assert.match(code, /add column if not exists remind_before_minutes integer;/);
  assert.match(code, /between -1440 and 10080/);
  assert.match(code, /create table if not exists push_block_alert_log/);
  assert.match(code, /primary key \(block_id, remind_at\)/);
  assert.match(code, /alter table push_block_alert_log enable row level security;/);
  assert.match(code, /revoke all on function push_claim_due_block_reminders\(\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function push_claim_due_block_reminders\(\) to service_role;/);
  assert.match(code, /interval '15 minutes'/);
});

test("0056: só acrescenta; não apaga dados nem mexe em políticas", () => {
  assert.doesNotMatch(code, /\b(drop|truncate)\b/i);
  assert.doesNotMatch(code, /delete from|update blocked_times|create policy|drop policy/i);
});

test("0056: o aviso só é reservado quando alguém tem aparelho", () => {
  assert.match(code, /where exists \(select 1 from devices v where v\.block_id = d\.block_id\)/);
});
