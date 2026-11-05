// Quedas do WhatsApp (0050 + worker 0.4.1): travas lidas dos arquivos, sem banco nem rede.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const sql = read("supabase/migrations/0050_whatsapp_connection_events.sql");

test("0050: histórico de quedas fechado ao app e liberado só ao worker", () => {
  assert.match(sql, /alter table whatsapp_private\.connection_events enable row level security/);
  assert.match(sql, /revoke all on whatsapp_private\.connection_events from public, anon, authenticated/);
  assert.match(sql, /revoke all on function whatsapp_private\.record_connection_event\(uuid, text, text, integer, text, integer\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function whatsapp_private\.record_connection_event\(uuid, text, text, integer, text, integer\) to wa_worker/);
  assert.doesNotMatch(sql, /to (anon|authenticated|public)\b/);
});

test("0050: só quem detém a posse da sessão registra evento, e o histórico tem prazo", () => {
  assert.match(sql, /perform whatsapp_private\.assert_lease\(p_company_id, p_worker_id\)/);
  assert.match(sql, /interval '30 days'/);
});

test("0050: logged_out guarda o motivo, e as credenciais continuam sendo apagadas só em logged_out/disconnected", () => {
  assert.match(sql, /last_error = case when p_status in \('error', 'logged_out'\) then left\(p_error, 500\) else null end/);
  assert.match(sql, /if p_status in \('logged_out', 'disconnected'\) then[\s\S]*delete from whatsapp_private\.auth/);
  // 'error' NUNCA apaga credenciais (é onde o worker para quando 500/411 não passam)
  const del = sql.slice(sql.indexOf("if p_status in ('logged_out', 'disconnected') then"));
  assert.doesNotMatch(del.split("end if;")[0], /'error'/);
});

test("worker 0.4.1: só o 401 apaga credenciais; 500 e 411 reconectam", () => {
  const utils = read("whatsapp-worker/src/wa-utils.js");
  assert.match(utils, /case 401: return 'logged_out'/);
  assert.match(utils, /case 500: return 'bad_session'/);
  assert.match(utils, /case 411: return 'bad_session'/);
  assert.doesNotMatch(utils, /case (500|411): return 'logged_out'/);
  const session = read("whatsapp-worker/src/session.js");
  assert.match(session, /kind === 'bad_session'/);
  assert.match(read("whatsapp-worker/src/index.js"), /const VERSION = '0\.4\.1'/);
  assert.match(read("whatsapp-worker/package.json"), /"version": "0\.4\.1"/);
});
