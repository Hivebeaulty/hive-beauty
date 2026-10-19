// Mensagens automáticas por data — regras puras (o banco confere: 0035_local.sh).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const m = load("lib/hive/auto-messages.ts");
const emojis = (s) => (s.match(/\p{Extended_Pictographic}/gu) || []).length;

test("as 6 mensagens: datas pedidas, 2 textos do sistema cada, singular, com o nome, até 1 emoji", () => {
  assert.deepEqual(m.AUTO_MESSAGES.map((x) => x.when).slice(0, 5), ["01/01", "08/03", "24/07", "15/09", "25/12"]);
  for (const { kind } of m.AUTO_MESSAGES) for (const tpl of m.AUTO_SYSTEM_TEMPLATES[kind]) {
    const out = m.renderAuto(tpl, { name: "Ana Maria Lima", business: "Studio", years: 3 });
    assert.match(out, /Ana/); assert.doesNotMatch(out, /Maria|\{|\}/);
    assert.doesNotMatch(out, /esperamos|desejamos|nossa equipe|estamos|a gente/i);
    assert.ok(emojis(out) <= 1, out);
  }
});

test("nome vazio não deixa pontuação quebrada; {anos} no singular e plural", () => {
  assert.equal(m.renderAuto("Feliz Natal, {nome}!", { name: "" }), "Feliz Natal!");
  assert.equal(m.renderAuto("Oi, {nome}! Faz {anos}.", { name: "  ", years: 1 }), "Oi! Faz 1 ano.");
  assert.equal(m.renderAuto("Faz {ANOS}, {Nome}.", { name: "Bia", years: 4 }), "Faz 4 anos, Bia.");
});

test("própria: variáveis por tipo ({anos} só no aniversário de cliente)", () => {
  assert.deepEqual(m.autoTemplateProblems("christmas", "Feliz Natal, {nome}! {negocio}"), []);
  assert.match(m.autoTemplateProblems("christmas", "Faz {anos}").join(" "), /desconhecida: \{anos\}/);
  assert.deepEqual(m.autoTemplateProblems("client_anniversary", "Faz {anos}, {nome}!"), []);
  assert.deepEqual(m.autoTemplateProblems("new_year", " "), ["Escreva a mensagem."]);
});

test("escolha: própria válida usa o texto dela; inválida cai no sistema; variação estável por ano", () => {
  const b = { kind: "christmas", clientId: "c1", year: 2026, name: "Ana" };
  assert.equal(m.buildAutoMessage({ ...b, mode: "custom", template: "Boas festas, {nome}!" }), "Boas festas, Ana!");
  assert.equal(m.buildAutoMessage({ ...b, mode: "custom", template: "Oi {xyz}" }), m.buildAutoMessage({ ...b, mode: "system" }));
  assert.equal(m.buildAutoMessage({ ...b, mode: "system" }), m.buildAutoMessage({ ...b, mode: "system" }));
});
