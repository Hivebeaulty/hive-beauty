// Aviso semanal de clientes sumidas (0049): texto, regra "sumida" idêntica à do app e travas de segurança.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("./load-ts.cjs");
const { transpileModule, ModuleKind } = require("typescript");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const lib = load(path.join(root, "lib/hive/push-alerts.ts"));
const rel = load(path.join(root, "lib/hive/relationship.ts"));
const edgeSrc = read("supabase/functions/push-appointment-alerts/index.ts");

// Extrai uma função exportada da Edge Function (que usa imports do Deno e não carrega no Node).
function edgeFn(name) {
  const code = edgeSrc.match(new RegExp(`export function ${name}[\\s\\S]*?\\n}\\n`))[0];
  const js = transpileModule(code, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const m = { exports: {} };
  new Function("exports", "module", js)(m.exports, m);
  return m.exports[name];
}

test("o aviso diz quantas são, manda olhar a lista e entrar em contato", () => {
  for (const n of [1, 2, 5, 37]) {
    const x = lib.overdueNotification(n);
    assert.match(x.title, new RegExp(`^${n} cliente`));
    assert.match(x.body, /lista/);
    assert.match(x.body, /entre em contato/);
    assert.equal(x.url, "/clientes?segmento=sumidas");
  }
  assert.equal(lib.overdueNotification(1).title, "1 cliente sumida");
  assert.equal(lib.overdueNotification(3).title, "3 clientes sumidas");
  assert.match(lib.overdueNotification(1).body, /com ela\.$/);
  assert.match(lib.overdueNotification(3).body, /com elas\.$/);
});

test("a função de envio usa o MESMO texto da biblioteca", () => {
  const fn = edgeFn("overdueNotification");
  for (const n of [1, 2, 5, 37]) assert.deepEqual(fn(n), lib.overdueNotification(n), String(n));
});

test("a tela de Clientes abre a lista 'sumidas' pelo link do aviso", () => {
  const page = read("app/(app)/clientes/page.tsx");
  assert.match(page, /searchParams\.get\("segmento"\)/);
  assert.match(page, /value: "sumidas"/);
});

test("regra de sumida da função = regra do app (aba Sumidas: atrasada e com pelo menos 1 visita)", () => {
  const isOverdue = edgeFn("isOverdueClient");
  const now = new Date("2026-11-04T12:00:00Z");
  const D = 86400000;
  const iso = (daysAgo) => new Date(now.getTime() - daysAgo * D).toISOString();
  const cases = [
    [], // sem visita
    [iso(10)], [iso(60)], [iso(61)], [iso(120)], // 1 visita: corte de 60 dias
    [iso(70), iso(40), iso(10)], // ritmo de 30 dias, em dia
    [iso(200), iso(170), iso(140)], // ritmo de 30 dias, 140 dias sem voltar
    [iso(100), iso(55)], // 45 dias de intervalo, 55 sem voltar: ainda dentro de 1,5x
    [iso(130), iso(55)], // 75 dias de intervalo, 55 sem voltar
    [iso(90), iso(60), iso(30), iso(46)], // fora de ordem
    [iso(400), iso(399), iso(398), iso(1)],
  ];
  for (const dates of cases) {
    const r = rel.computeClientRelationship(dates, now);
    const esperado = r.isOverdue && r.visitCount > 0;
    assert.equal(isOverdue(dates, now.getTime()), esperado, JSON.stringify(dates.map((d) => Math.round((now - new Date(d)) / D))));
  }
});

test("a contagem usa só clientes ativas e atendimentos concluídos, e lê em páginas", () => {
  assert.match(edgeSrc, /\.from\("clients"\)\.select\("id"\)\.eq\("company_id", companyId\)\.is\("archived_at", null\)/);
  assert.match(edgeSrc, /\.eq\("status", "concluido"\)/);
  assert.match(edgeSrc, /const PAGE = 1000/);
  assert.match(edgeSrc, /if \(n === 0\) \{ overdue\.none\+\+; continue; \}/, "sem sumidas não manda aviso");
});

test("um erro no aviso de sumidas não derruba o aviso antes do atendimento", () => {
  const apptAt = edgeSrc.indexOf('rpc("push_claim_due_alerts")');
  const overdueAt = edgeSrc.indexOf('rpc("push_claim_weekly_overdue"');
  assert.ok(apptAt > 0 && overdueAt > apptAt, "atendimento primeiro");
  assert.match(edgeSrc.slice(overdueAt - 200, overdueAt), /try \{/);
  assert.match(edgeSrc, /overdue\.error = true/);
});

test("a função só aceita o teste manual com um UUID válido", () => {
  assert.match(edgeSrc, /forceOverdueMember/);
  assert.match(edgeSrc, /const UUID = /);
});

test("migration 0049: tabela fechada, reserva só para service_role, segunda às 9h, uma vez por semana", () => {
  const sql = read("supabase/migrations/0049_push_overdue_clients.sql");
  assert.match(sql, /alter table push_weekly_log enable row level security/);
  assert.match(sql, /revoke all on push_weekly_log from public, anon, authenticated/);
  assert.ok(sql.includes("revoke all on function push_claim_weekly_overdue(uuid) from public, anon, authenticated"));
  assert.ok(sql.includes("grant execute on function push_claim_weekly_overdue(uuid) to service_role"));
  assert.ok(!sql.includes("grant execute on function push_claim_weekly_overdue(uuid) to authenticated"));
  assert.match(sql, /extract\(isodow from t\) = 1/);
  assert.match(sql, /t::time >= time '09:00'/);
  assert.match(sql, /primary key \(member_id, kind, week_start\)/);
  assert.match(sql, /coalesce\(pp\.overdue_clients_alert, true\)/);
  assert.match(sql, /m\.user_id = auth\.uid\(\) and m\.active/);
});

test("card: liga/desliga o aviso de sumidas e some só essa opção se a migration não existir", () => {
  const card = read("components/settings/push-alerts-card.tsx");
  assert.match(card, /push_get_overdue_alert/);
  assert.match(card, /push_set_overdue_alert/);
  assert.match(card, /overdue !== null &&/);
  assert.match(card, /role="switch"/);
});
