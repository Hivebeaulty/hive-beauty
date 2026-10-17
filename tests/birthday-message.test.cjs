// Mensagem de aniversário — regras puras (cópia idêntica no banco: 0031).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const b = load("lib/hive/birthday-message.ts");
const emojis = (s) => (s.match(/\p{Extended_Pictographic}/gu) || []).length;

test("sistema: 6 variações, todas com o 1º nome, no singular, no máximo 1 emoji", () => {
  const seen = new Map();
  for (let i = 0; i < 300 && seen.size < 6; i++) {
    const id = `cli-${i}`;
    seen.set(b.birthdayVariant(id, 2026), b.buildBirthdaySystemMessage("Ana Maria Lima", id, 2026));
  }
  assert.equal(seen.size, 6);
  for (const m of seen.values()) {
    assert.match(m, /Ana/); assert.doesNotMatch(m, /Maria|Lima/);
    assert.match(m, /anivers|Parabéns/i);
    assert.doesNotMatch(m, /esperamos|desejamos|nossa|nosso|a gente|estamos/i);
    assert.ok(emojis(m) <= 1, m);
  }
});

test("sistema: mesma cliente e ano => mesmo texto; ano novo pode variar; sem nome fica natural", () => {
  assert.equal(b.buildBirthdaySystemMessage("Ana", "x", 2026), b.buildBirthdaySystemMessage("Ana", "x", 2026));
  for (let i = 0; i < 60; i++) {
    const m = b.buildBirthdaySystemMessage("", `c${i}`, 2026);
    assert.doesNotMatch(m, /, !|,\s*,|^\s|undefined|null/, m);
    assert.match(m, /^[A-ZÁÉÍÓÚÂÊÔ]/, m);
  }
});

test("própria: {nome}/{negocio} (maiúsculas e acentos aceitos); variável desconhecida recusada", () => {
  assert.equal(b.renderBirthdayTemplate("Parabéns, {Nome}! Beijo do {NEGÓCIO}.", "Ana Lima", "Studio Bella"), "Parabéns, Ana! Beijo do Studio Bella.");
  assert.equal(b.renderBirthdayTemplate("Parabéns {nome}!", "", "X"), "Parabéns!");
  assert.deepEqual(b.birthdayTemplateProblems(b.DEFAULT_BIRTHDAY_TEMPLATE), []);
  assert.deepEqual(b.birthdayTemplateProblems("  "), ["Escreva a mensagem."]);
  assert.match(b.birthdayTemplateProblems("Oi {nome} {data}").join(" "), /desconhecida: \{data\}/);
});

test("escolha: própria válida usa o texto dela; inválida cai nas variações do sistema", () => {
  const base = { clientName: "Ana", businessName: "Studio", clientId: "x", year: 2026 };
  assert.equal(b.buildBirthdayMessage({ ...base, mode: "custom", template: "Feliz dia, {nome}!" }), "Feliz dia, Ana!");
  assert.equal(b.buildBirthdayMessage({ ...base, mode: "custom", template: "Oi {cupom}" }), b.buildBirthdaySystemMessage("Ana", "x", 2026));
  assert.equal(b.buildBirthdayMessage({ ...base, mode: "system", template: "Feliz dia, {nome}!" }), b.buildBirthdaySystemMessage("Ana", "x", 2026));
});
