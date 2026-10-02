const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const phone = load("lib/hive/phone.ts");

const norm = (s) => phone.normalizeBrazilPhone(s);

test("celular em vários formatos vira o mesmo número normalizado", () => {
  const expected = "5511999990000";
  for (const raw of [
    "11999990000",
    "(11) 99999-0000",
    "11 99999 0000",
    "+55 11 99999-0000",
    "55 11 99999-0000",
    "5511999990000",
    "011 99999-0000",       // zero de tronco
    "0055 11 99999-0000",   // prefixo internacional 00
    " 11.99999.0000 ",
  ]) {
    assert.equal(norm(raw), expected, `formato: ${raw}`);
  }
});

test("fixo é válido, mas não é capaz de WhatsApp", () => {
  const r = phone.parseBrazilPhone("(11) 3222-1234");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "landline");
  assert.equal(r.normalized, "551132221234");
  assert.equal(phone.isWhatsappCapable(r.normalized), false);
  assert.equal(phone.isWhatsappCapable("5511999990000"), true);
});

test("DDD 55 (RS) não é confundido com o código do país", () => {
  assert.equal(norm("55 99999-1234"), "5555999991234");      // 11 dígitos locais
  assert.equal(norm("(55) 3222-1234"), "555532221234");      // 10 dígitos locais
  assert.equal(norm("+55 55 99999-1234"), "5555999991234");  // com DDI
  assert.equal(phone.whatsappChatLink("55 99999-1234"), "https://wa.me/5555999991234");
});

test("números claramente inválidos são rejeitados com motivo", () => {
  const cases = [
    ["", "empty"],
    ["   ", "empty"],
    ["abc", "empty"],
    ["12345", "too_short"],
    ["999990000", "too_short"],            // sem DDD (9 dígitos)
    ["(00) 99999-0000", "too_short"],     // "00" é lido como prefixo internacional; sobra curto demais
    ["(10) 99999-0000", "invalid_ddd"],
    ["(20) 99999-0000", "invalid_ddd"],
    ["11 8888-7777", "missing_nine"],       // celular antigo sem o 9: pede correção
    ["11 88888-7777", "invalid_format"],    // 9 dígitos que não começam com 9
    ["11 1234-5678", "invalid_format"],     // 8 dígitos começando com 1
    ["+44 20 7946 0958", "unsupported"],    // Reino Unido (12 dígitos, DDI diferente de 55)
    ["+1 415 555 2671", "invalid_format"],  // EUA: 11 dígitos e "14" é DDD válido, mas 9 dígitos não começam com 9
    ["5511999990000123", "unsupported"],
  ];
  for (const [raw, reason] of cases) {
    const r = phone.parseBrazilPhone(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.reason, reason, `${raw} -> ${r.reason}`);
    assert.ok(r.message.length > 0);
    assert.equal(norm(raw), null);
  }
});

test("formatação amigável e fallback para o texto original", () => {
  assert.equal(phone.formatBrazilPhone("11999990000"), "(11) 99999-0000");
  assert.equal(phone.formatBrazilPhone("+5511999990000"), "(11) 99999-0000");
  assert.equal(phone.formatBrazilPhone("1132221234"), "(11) 3222-1234");
  assert.equal(phone.formatBrazilPhone("  123  "), "123");   // inválido: não esconde o que foi digitado
  assert.equal(phone.formatBrazilPhone(null), "");
});

test("phoneDisplay prefere o valor normalizado do banco", () => {
  assert.equal(phone.phoneDisplay("11999990000", "5511999990000"), "(11) 99999-0000");
  assert.equal(phone.phoneDisplay("11999990000", null), "(11) 99999-0000");
  assert.equal(phone.phoneDisplay("ligar à tarde", null), "ligar à tarde");
  assert.equal(phone.phoneDisplay(null, null), null);
  assert.equal(phone.phoneDisplay("  ", null), null);
});

test("link do WhatsApp só para celular válido", () => {
  assert.equal(phone.whatsappChatLink("(11) 99999-0000"), "https://wa.me/5511999990000");
  assert.equal(phone.whatsappChatLink("(11) 3222-1234"), null);
  assert.equal(phone.whatsappChatLink("123"), null);
  assert.equal(phone.whatsappChatLink(null), null);
});

// ---- Auditoria final: casos pedidos explicitamente (DDD 31) -----------------
test("auditoria: mesmo celular de BH em todos os formatos, nada inventado", () => {
  const expected = "5531999999999";
  for (const raw of ["+55 31 99999-9999", "(31) 99999-9999", "31 99999-9999", "31999999999", "5531999999999", "031 99999-9999"]) {
    assert.equal(norm(raw), expected, raw);
  }
  // Os dígitos de saída são exatamente os de entrada (+55 só quando faltava).
  assert.equal(norm("31999999999"), "55" + "31999999999");
});

test("auditoria: fixo, sem DDD, DDI, inválido, 8 dígitos", () => {
  assert.equal(norm("(31) 3222-1234"), "553132221234");              // fixo
  assert.equal(phone.parseBrazilPhone("(31) 3222-1234").kind, "landline");
  assert.equal(phone.parseBrazilPhone("99999-9999").reason, "too_short");   // sem DDD (9 dígitos)
  assert.equal(phone.parseBrazilPhone("3222-1234").reason, "too_short");    // sem DDD (8 dígitos)
  assert.equal(norm("+55 31 99999-9999"), "5531999999999");                 // com DDI
  assert.equal(norm("+55 31 9999-9999"), null);                             // DDI + celular sem o 9
  assert.equal(phone.parseBrazilPhone("31 9999-9999").reason, "missing_nine");
  assert.equal(norm("31 99999-999"), null);                                 // 1 dígito a menos
  assert.equal(norm("(31) 99999-99999"), null);                             // 1 dígito a mais
  assert.equal(norm("abc"), null);
  // nunca inventa dígitos: ninguém que falha vira número
  for (const bad of ["31 9999-9999", "99999-9999", "12345", "31 99999-999"]) assert.equal(norm(bad), null, bad);
});

test("auditoria: duas clientes com o mesmo número em formatos diferentes colidem; números diferentes não", () => {
  const a = norm("(31) 99999-9999");
  const b = norm("+55 31 99999 9999");
  const c = norm("31 99999-9998");
  assert.equal(a, b);
  assert.notEqual(a, c);
  // DDD 55 (RS) e DDI 55 não se confundem
  assert.notEqual(norm("55 99999-9999"), norm("31 99999-9999"));
});

test("auditoria: o texto original não é alterado pela exibição", () => {
  const original = "31999999999";
  assert.equal(phone.phoneDisplay(original, "5531999999999"), "(31) 99999-9999");
  assert.equal(original, "31999999999"); // phoneDisplay só lê; o valor gravado em clients.phone continua o original
});
