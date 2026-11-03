// Aviso no celular antes do atendimento (0048): opções, textos, service worker, função de envio
// e as travas de segurança da migration. Sem Postgres nem Deno: lógica pura e leitura dos arquivos.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const { load } = require("./load-ts.cjs");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const lib = load(path.join(root, "lib/hive/push-alerts.ts"));

test("opções de antecedência: 15 min, 30 min, 1 h e 2 h, todas válidas", () => {
  assert.deepEqual(lib.ALERT_OPTIONS.map((o) => o.value), [15, 30, 60, 120]);
  for (const o of lib.ALERT_OPTIONS) assert.equal(lib.isValidAlertMinutes(o.value), true, String(o.value));
  assert.equal(lib.isValidAlertMinutes(lib.DEFAULT_ALERT_MINUTES), true);
});

test("antecedência inválida é recusada", () => {
  for (const v of [0, 4, 1441, -15, 30.5, "30", null, undefined, NaN]) assert.equal(lib.isValidAlertMinutes(v), false, String(v));
});

test("textos de antecedência", () => {
  assert.equal(lib.minutesLabel(15), "15 min");
  assert.equal(lib.minutesLabel(30), "30 min");
  assert.equal(lib.minutesLabel(60), "1 h");
  assert.equal(lib.minutesLabel(90), "1 h 30 min");
  assert.equal(lib.minutesLabel(120), "2 h");
});

test("a função de envio usa o MESMO minutesLabel da biblioteca", () => {
  const edge = read("supabase/functions/push-appointment-alerts/index.ts");
  const fn = edge.match(/export function minutesLabel[\s\S]*?\n}\n/)[0];
  const { transpileModule, ModuleKind } = require("typescript");
  const js = transpileModule(fn, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const m = { exports: {} };
  new Function("exports", "module", js)(m.exports, m);
  for (const n of [5, 15, 30, 45, 60, 90, 120, 180, 1440]) assert.equal(m.exports.minutesLabel(n), lib.minutesLabel(n), String(n));
});

test("a chave VAPID pública vira os 65 bytes que o navegador espera", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  const bytes = lib.urlBase64ToUint8Array(pub);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  assert.deepEqual(Buffer.from(bytes).toString("base64url"), pub);
});

test("service worker: mostra o aviso e abre o app ao tocar", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /showNotification/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  assert.match(sw, /openWindow/);
});

test("função de envio: exige o segredo do cron e só aceita POST", () => {
  const edge = read("supabase/functions/push-appointment-alerts/index.ts");
  assert.match(edge, /req\.method !== "POST"/);
  assert.match(edge, /x-cron-secret/);
  assert.match(edge, /push_cron_secret_ok/);
  assert.match(edge, /push_claim_due_alerts/);
  assert.match(edge, /push_drop_subscriptions/);
  assert.doesNotMatch(edge, /VAPID_PRIVATE_KEY["']?\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/, "chave privada no código");
});

test("migration 0048: tabelas fechadas, RPCs de serviço só para service_role", () => {
  const sql = read("supabase/migrations/0048_push_appointment_alerts.sql");
  for (const t of ["push_subscriptions", "push_prefs", "push_alert_log"]) {
    assert.match(sql, new RegExp(`alter table ${t} enable row level security`), t);
    assert.match(sql, new RegExp(`revoke all on ${t} from public, anon, authenticated`), t);
  }
  for (const f of ["push_cron_secret_ok(text)", "push_claim_due_alerts()", "push_drop_subscriptions(uuid[])"]) {
    assert.ok(sql.includes(`revoke all on function ${f} from public, anon, authenticated`), f);
    assert.ok(sql.includes(`grant execute on function ${f} to service_role`), f);
    assert.ok(!sql.includes(`grant execute on function ${f} to authenticated`), f);
  }
  // As chamadas da profissional checam login e participação na empresa.
  assert.match(sql, /auth\.uid\(\) is null then raise exception 'Não autenticado'/);
  assert.match(sql, /m\.user_id = auth\.uid\(\) and m\.active/);
});

test("migration 0048: só atendimentos abertos, sem aviso atrasado e sem repetir", () => {
  const sql = read("supabase/migrations/0048_push_appointment_alerts.sql");
  assert.match(sql, /a\.status in \('agendado', 'confirmado'\)/);
  assert.match(sql, /a\.scheduled_start > now\(\)/);
  assert.match(sql, /now\(\) - interval '15 minutes'/);
  assert.match(sql, /primary key \(appointment_id, scheduled_start\)/);
  assert.match(sql, /on conflict do nothing/);
});
