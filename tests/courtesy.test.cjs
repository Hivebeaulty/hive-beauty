// Cortesia com prazo (0054) — lógica pura das telas, estados de acesso e conferência dos arquivos.
// O banco (prazo, permissões, auditoria, reversão) é testado em supabase/tests/local/0054_local.sh.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { load } = require("./load-ts.cjs");
const c = load("lib/hive/courtesy.ts");
const a = load("lib/hive/access.ts");
const sub = load("lib/hive/subscription.ts");

const NOW = new Date("2026-11-17T15:00:00Z"); // 12h em Brasília

test("o último dia da cortesia segue a conta do banco (Brasília)", () => {
  assert.equal(c.courtesyEndPreview(30, NOW), "17/12/2026");
  assert.equal(c.courtesyEndPreview(90, NOW), "15/02/2027");
  assert.equal(c.courtesyEndPreview(1, NOW), "18/11/2026");
  // 01h em Brasília de 18/11 (04h UTC) ainda conta como 18/11, não 17/11
  assert.equal(c.courtesyEndPreview(30, new Date("2026-11-18T04:00:00Z")), "18/12/2026");
  // 23h30 em Brasília de 17/11 (02h30 UTC de 18/11) continua sendo 17/11
  assert.equal(c.courtesyEndPreview(30, new Date("2026-11-18T02:30:00Z")), "17/12/2026");
});

test("estender: soma ao fim atual se ainda vale; conta de hoje se já venceu", () => {
  assert.equal(c.extendEndPreview("2026-12-18T02:59:59Z", 30, NOW), "16/01/2027"); // fim em 17/12 (Brasília) + 30 dias
  assert.equal(c.extendEndPreview("2026-11-01T02:59:59Z", 30, NOW), "17/12/2026");
  assert.equal(c.extendEndPreview(null, 30, NOW), "17/12/2026");
});

test("dias que faltam, pelo dia de Brasília", () => {
  assert.equal(c.daysLeft("2026-11-18T02:59:59Z", NOW), 0); // termina hoje 23:59:59
  assert.equal(c.daysLeft("2026-11-25T02:59:59Z", NOW), 7);
  assert.equal(c.daysLeft("2026-11-11T02:59:59Z", NOW), -7);
  assert.equal(c.daysLeft(null, NOW), null);
  assert.equal(c.formatDay("2026-12-18T02:59:59Z"), "17/12/2026");
});

test("formulário: confere o que o banco confere, com texto em português", () => {
  const ok = { email: "ana@x.com", name: "Ana", days: 30, origin: "parceria", reason: "parceira do instagram" };
  assert.equal(c.grantFormProblem(ok), null);
  assert.match(c.grantFormProblem({ ...ok, email: "ana" }), /e-mail/);
  assert.match(c.grantFormProblem({ ...ok, days: 0 }), /1 a 365/);
  assert.match(c.grantFormProblem({ ...ok, days: 366 }), /1 a 365/);
  assert.match(c.grantFormProblem({ ...ok, days: 1.5 }), /1 a 365/);
  assert.match(c.grantFormProblem({ ...ok, origin: "" }), /origem/);
  assert.match(c.grantFormProblem({ ...ok, reason: "abc" }), /motivo/);
  assert.match(c.grantFormProblem({ ...ok, name: "x".repeat(121) }), /nome/);
  assert.equal(c.reasonProblem("      "), "Escreva o motivo (de 5 a 500 caracteres).");
  assert.equal(c.reasonProblem("tudo certo"), null);
});

test("resposta da lista: aceita o formato do banco, ignora o que não reconhece, falha para null", () => {
  const rows = [
    { id: "1", email: "a@x.com", origin: "parceria", days: 30, ends_at: "2026-12-18T02:59:59Z", has_account: true, situation: "ativa", now_status: "courtesy", extensions: 1 },
    { id: null, email: "b@x.com", situation: "sem_prazo", has_account: true, now_status: "free" },
    { email: "c@x.com", situation: "inventada" },
    null,
  ];
  const l = c.parseCourtesies(rows, null);
  assert.equal(l.length, 2);
  assert.equal(l[0].extensions, 1);
  assert.equal(l[1].situation, "sem_prazo");
  assert.equal(c.parseCourtesies(null, null), null);
  assert.equal(c.parseCourtesies(rows, { message: "x" }), null);
  assert.equal(c.convertedToPaying({ nowStatus: "active" }), true);
  assert.equal(c.convertedToPaying({ nowStatus: "courtesy" }), false);
});

test("mensagens de erro e de sucesso", () => {
  assert.match(c.courtesyErrorMessage("AUA01", "x"), /duas etapas/);
  assert.equal(c.courtesyErrorMessage("ACG01", "Esta pessoa já tem assinatura ativa. Não precisa de cortesia."), "Esta pessoa já tem assinatura ativa. Não precisa de cortesia.");
  assert.match(c.courtesyErrorMessage("XX000", "erro interno do banco"), /Tente de novo/);
  assert.doesNotMatch(c.courtesyErrorMessage("XX000", "erro interno do banco"), /banco/);
  assert.match(c.grantResultMessage({ account: { created: true, emailSent: true } }, "a@x.com", "17/12/2026"), /criar a senha/);
  assert.match(c.grantResultMessage({ account: { hadAccount: true } }, "a@x.com", "17/12/2026"), /senha de sempre/);
  assert.match(c.grantResultMessage({ account: { error: true } }, "a@x.com", "17/12/2026"), /Reenviar e-mail/);
});

test("acesso: cortesia dentro do prazo libera, com a data e o aviso", () => {
  const ok = a.parseAccess({ status: "courtesy", allowed: true, warning: true, until: "2026-12-18T02:59:59Z" }, null);
  assert.equal(ok.status, "courtesy");
  assert.equal(ok.allowed, true);
  assert.equal(ok.warning, true);
  assert.equal(ok.until, "2026-12-18T02:59:59Z");
  const calm = a.parseAccess({ status: "courtesy", allowed: true, warning: false, until: "2026-12-18T02:59:59Z" }, null);
  assert.equal(calm.warning, false);
});

test("acesso: falha FECHADA (sem data, sem 'allowed', ou encerrada)", () => {
  assert.equal(a.parseAccess({ status: "courtesy", allowed: true, warning: false }, null).allowed, false);
  assert.equal(a.parseAccess({ status: "courtesy", allowed: true, until: "lixo" }, null).allowed, false);
  assert.equal(a.parseAccess({ status: "courtesy", allowed: false, until: "2026-12-18T02:59:59Z" }, null).allowed, false);
  const ended = a.parseAccess({ status: "courtesy_ended", allowed: true }, null);
  assert.equal(ended.status, "courtesy_ended");
  assert.equal(ended.allowed, false);
  assert.equal(a.parseAccess({ status: "free", allowed: true, warning: false }, null).allowed, true); // cortesia antiga, sem prazo
});

test("a tela do fim da cortesia: dona assina, equipe é orientada; link do plano sem teste", () => {
  const owner = a.accessCopy("courtesy_ended", true);
  assert.equal(owner.title, "Sua cortesia terminou");
  assert.equal(owner.canSubscribe, true);
  assert.match(owner.text, /nada foi apagado/);
  assert.equal(a.accessCopy("courtesy_ended", false).canSubscribe, false);
  assert.equal(a.checkoutUrlFor("courtesy_ended"), a.CHECKOUT_AFTER_TRIAL_URL);
  assert.equal(a.checkoutUrlFor("courtesy", "cortesia"), a.CHECKOUT_AFTER_TRIAL_URL);
});

test("assinatura no app: cortesia com prazo mostra a data; vencida convida a assinar", () => {
  const base = { status: "free", provider: "cortesia", courtesy_ends_at: "2026-12-18T02:59:59Z", can_cancel: false, payments: [] };
  const live = sub.parseSubscription({ ...base, access: { status: "courtesy", allowed: true, warning: false, until: "2026-12-18T02:59:59Z" } }, null);
  const d = sub.describeSubscription(live);
  assert.equal(d.title, "Cortesia");
  assert.match(d.lines[0], /até 17\/12\/2026/);
  assert.equal(d.canSubscribe, true);
  const ended = sub.describeSubscription(sub.parseSubscription({ ...base, access: { status: "courtesy_ended", allowed: false } }, null));
  assert.equal(ended.title, "Sua cortesia terminou");
  // cortesia antiga, sem prazo: igual a antes
  const old = sub.describeSubscription(sub.parseSubscription({ status: "free", provider: "cortesia", access: { status: "free", allowed: true, warning: false }, payments: [] }, null));
  assert.equal(old.title, "Cortesia");
  assert.equal(old.canSubscribe, false);
});

test("o texto da cortesia é natural: sem jargão e sem emoji", () => {
  const texts = [a.accessCopy("courtesy_ended", true).title, a.accessCopy("courtesy_ended", true).text,
    c.grantResultMessage({ account: { created: true, emailSent: true } }, "a@x.com", "17/12/2026")];
  for (const t of texts) assert.doesNotMatch(t, /plataforma|solução|automatiz|[\u{1F300}-\u{1FAFF}]/iu, t);
});

test("a função admin-courtesy exige sessão da dona e não cria conta sozinha", () => {
  const src = fs.readFileSync("supabase/functions/admin-courtesy/index.ts", "utf8");
  assert.match(src, /admin_courtesy_grant/);                    // a cortesia sai do banco, com a sessão dela
  assert.match(src, /global: \{ headers: \{ Authorization: auth \} \}/);
  assert.match(src, /startsWith\("Bearer "\)/);
  assert.match(src, /admin_list_courtesies/);                   // convite só para cortesia ativa
  assert.match(src, /created\.error\.status !== 422/);          // conta existente: não mexe na senha
  assert.doesNotMatch(src, /password\s*:/i);                    // nunca define senha
  assert.match(src, /redefinir-senha/);
});

test("a migration 0054 e a reversão existem e se correspondem", () => {
  const sql = fs.readFileSync("supabase/migrations/0054_courtesy_with_deadline.sql", "utf8");
  for (const f of ["admin_courtesy_grant", "admin_courtesy_extend", "admin_courtesy_revoke", "admin_list_courtesies", "billing_effective_status"]) {
    assert.match(sql, new RegExp(f));
    assert.match(fs.readFileSync("supabase/operations/0054_reversao.sql", "utf8"), new RegExp(`drop function if exists ${f}`));
  }
  assert.match(sql, /admin_assert\(\)/);
  assert.match(sql, /admin_log\('courtesy_grant'/);
});
