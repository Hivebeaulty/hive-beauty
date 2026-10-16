const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const msg = load("lib/hive/appointment-message.ts");
const dn = load("lib/hive/display-name.ts");
const fin = load("lib/hive/payment-methods.ts");
const flow = load("lib/hive/appointment-flow.ts");
const phone = load("lib/hive/phone.ts");

// 15/10/2026 14:00 em Brasília = 17:00Z (quinta-feira)
const START = new Date("2026-10-15T17:00:00Z");
const NOW = new Date("2026-10-10T12:00:00Z");
const base = {
  clientName: "Maria da Silva", startsAt: START, durationMinutes: 90, serviceName: "Alongamento em gel",
  professionalName: "Paty", businessName: "Studio Bella", now: NOW,
};

function emojis(s) { return (s.match(/\p{Extended_Pictographic}/gu) || []).length; }

test("mensagem: primeiro nome, dia, hora e serviço; SEM assinatura de empresa ou profissional", () => {
  for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
    const m = msg.buildConfirmationMessage({ ...base, variantSeed: seed });
    assert.match(m, /^Oi, Maria[!,]/); assert.doesNotMatch(m, /da Silva/);
    assert.match(m, /15\/10 \(quinta-feira\), às 14h/);
    assert.match(m, /Alongamento em gel/);
    assert.doesNotMatch(m, /Studio Bella|Paty|·/, "não pode ter assinatura");
    assert.ok(emojis(m) <= 1, "no máximo 1 emoji");
    assert.doesNotMatch(m, /\n{3,}/);
    assert.doesNotMatch(m, /\s$/);
  }
});

test("mensagem: hora com minutos, 'hoje' e 'amanhã' encaixados na frase", () => {
  const at = (iso, now, seed = "a") => msg.buildConfirmationMessage({ ...base, startsAt: new Date(iso), now: new Date(now), variantSeed: seed });
  assert.match(at("2026-10-15T17:30:00Z", "2026-10-10T12:00:00Z"), /às 14h30/);
  assert.match(at("2026-10-15T12:00:00Z", "2026-10-10T12:00:00Z"), /às 9h[^0-9]/);
  for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    assert.match(at("2026-10-15T17:00:00Z", "2026-10-15T09:00:00Z", seed), /hoje, quinta-feira \(15\/10\), às 14h/);
    assert.match(at("2026-10-16T17:00:00Z", "2026-10-15T09:00:00Z", seed), /amanhã, sexta-feira \(16\/10\), às 14h/);
    assert.doesNotMatch(at("2026-10-16T17:00:00Z", "2026-10-15T09:00:00Z", seed), /(no dia|o dia) amanhã|para no dia/);
  }
});

test("mensagem: independe do fuso do servidor (UTC às 22h de Brasília)", () => {
  for (const tz of ["UTC", "America/Sao_Paulo", "Asia/Tokyo"]) {
    const prev = process.env.TZ; process.env.TZ = tz;
    try {
      // 23:30 em Brasília = 02:30Z do dia seguinte: precisa continuar 'dia 15, 23h30'
      const m = msg.buildConfirmationMessage({ ...base, startsAt: new Date("2026-10-16T02:30:00Z"), now: NOW });
      assert.match(m, /15\/10 \(quinta-feira\), às 23h30/, tz);
      // 'amanhã' calculado pelo dia de Brasília, não do servidor (01:00Z = 22:00 do dia 14)
      const t = msg.buildConfirmationMessage({ ...base, startsAt: new Date("2026-10-15T17:00:00Z"), now: new Date("2026-10-15T01:00:00Z") });
      assert.match(t, /amanhã, quinta-feira \(15\/10\)/, tz);
    } finally { process.env.TZ = prev; }
  }
});

test("mensagem: 8 variações determinísticas, todas completas; emoji em parte delas (no máximo 1)", () => {
  const byVariant = new Map();
  for (let i = 0; i < 400 && byVariant.size < msg.CONFIRMATION_VARIANTS; i++) {
    const seed = `seed-${i}`;
    const m = msg.buildConfirmationMessage({ ...base, variantSeed: seed });
    assert.equal(m, msg.buildConfirmationMessage({ ...base, variantSeed: seed }), "mesma entrada => mesma mensagem");
    byVariant.set(msg.confirmationVariant(seed), m);
  }
  assert.equal(msg.CONFIRMATION_VARIANTS, 8);
  assert.equal(byVariant.size, 8, "todas as 8 variações aparecem");
  const texts = [...byVariant.values()];
  assert.equal(new Set(texts).size, 8, "as 8 variações são textos diferentes");
  for (const m of texts) {
    assert.match(m, /Alongamento em gel/); assert.match(m, /15\/10/); assert.match(m, /às 14h/);
    assert.ok(emojis(m) <= 1);
  }
  const comEmoji = texts.filter((m) => emojis(m) === 1).length;
  assert.ok(comEmoji >= 2 && comEmoji <= 6, `emoji ocasional (${comEmoji} de 8)`);
});

test("mensagem: sem serviço / sem nome continua natural; profissional e empresa nunca aparecem", () => {
  for (let i = 0; i < 400; i++) {
    const seed = `s-${i}`;
    const noSv = msg.buildConfirmationMessage({ ...base, serviceName: "  ", variantSeed: seed });
    assert.doesNotMatch(noSv, /(de|para|:) *[.,]| {2,}|: no dia|de :/, noSv);
    assert.match(noSv, /15\/10 \(quinta-feira\), às 14h/);
    const noName = msg.buildConfirmationMessage({ ...base, clientName: "", variantSeed: seed });
    assert.match(noName, /^Oi[!,]/);
    const named = msg.buildConfirmationMessage({ ...base, professionalName: "Studio Bella", businessName: "Studio Bella", variantSeed: seed });
    assert.doesNotMatch(named, /Studio Bella/);
  }
});

test("WhatsApp da confirmação: link com a mensagem codificada; sem link para fixo/inválido/sem telefone", () => {
  const text = msg.buildConfirmationMessage(base);
  const link = phone.whatsappChatLink("(31) 99999-9999", null, text);
  assert.ok(link.startsWith("https://wa.me/5531999999999?text="));
  assert.equal(decodeURIComponent(link.split("?text=")[1]), text);
  assert.equal(phone.whatsappChatLink("(31) 3222-1234", null, text), null);
  assert.equal(phone.whatsappChatLink("123", null, text), null);
  assert.equal(phone.whatsappChatLink(null, null, text), null);
  // usa o número NORMALIZADO do banco quando existe
  assert.ok(phone.whatsappChatLink("lixo", "5531999999999", text).startsWith("https://wa.me/5531999999999?text="));
});

test("nome de exibição: Paty ganha de Patrícia; fallback em cadeia; limites", () => {
  assert.equal(dn.resolveGreetingName({ displayName: "Paty", profileFullName: "Patrícia Santos", metadataFullName: "Patrícia Santos" }), "Paty");
  assert.equal(dn.resolveGreetingName({ displayName: "  Dra.  Paty ", profileFullName: "Patrícia Santos" }), "Dra. Paty"); // como digitado
  assert.equal(dn.resolveGreetingName({ displayName: "", profileFullName: "Patrícia Santos" }), "Patrícia");
  assert.equal(dn.resolveGreetingName({ displayName: null, profileFullName: null, metadataFullName: "Ana Lima" }), "Ana");
  assert.equal(dn.resolveGreetingName({}), null);
  assert.equal(dn.normalizeDisplayNameInput("   "), null);
  assert.equal(dn.normalizeDisplayNameInput("a".repeat(60)).length, 40);
  assert.equal(dn.resolveSignatureName({ displayName: "Paty", fullName: "Patrícia Santos" }), "Paty");
  assert.equal(dn.resolveSignatureName({ displayName: null, fullName: "Patrícia Santos" }), "Patrícia");
});

test("formas de pagamento: PIX é o padrão; crédito/débito existem; 'cartao' antigo preservado", () => {
  assert.equal(fin.DEFAULT_PAYMENT_METHOD, "pix");
  assert.deepEqual(fin.SELECTABLE_PAYMENT_METHODS, ["pix", "dinheiro", "cartao_credito", "cartao_debito", "outro"]);
  assert.equal(fin.PAYMENT_METHOD_LABEL.cartao_credito, "Cartão de crédito");
  assert.equal(fin.PAYMENT_METHOD_LABEL.cartao_debito, "Cartão de débito");
  assert.equal(fin.PAYMENT_METHOD_LABEL.cartao, "Cartão");           // histórico continua legível
  const normal = fin.paymentMethodOptions("pix").map((o) => o.value);
  assert.ok(!normal.includes("cartao"));                              // novo lançamento não oferece o antigo
  const legacy = fin.paymentMethodOptions("cartao");
  assert.ok(legacy.some((o) => o.value === "cartao"));                // registro antigo continua selecionável
  for (const v of ["pix", "dinheiro", "cartao_credito", "cartao_debito"]) assert.ok(fin.PAYMENT_METHOD_LABEL[v]);
});

test("permissões do recebimento e da exclusão", () => {
  const m = (role, memberId, prof) => flow.canManageAppointmentPayment({ role, memberId, professionalMemberId: prof });
  assert.equal(m("owner", "x", "y"), true);
  assert.equal(m("admin", "x", "y"), true);
  assert.equal(m("professional", "y", "y"), true);
  assert.equal(m("professional", "x", "y"), false);
  assert.equal(m("reception", "y", "y"), false);
  assert.equal(flow.canDeleteAppointment("owner"), true);
  assert.equal(flow.canDeleteAppointment("admin"), true);
  assert.equal(flow.canDeleteAppointment("professional"), false);
  assert.equal(flow.canDeleteAppointment("reception"), false);
  assert.match(flow.deleteErrorMessage("22023"), /concluídos/);
  assert.match(flow.deleteErrorMessage("42501"), /administração/);
  assert.match(flow.deleteErrorMessage(undefined), /Nada foi alterado/);
  assert.match(flow.paymentUpdateErrorMessage("22023"), /concluído/);
});

test("whatsappReach: ok, sem telefone, fixo, inválido (mesma regra do banco)", () => {
  assert.equal(phone.whatsappReach("(31) 99999-9999"), "ok");
  assert.equal(phone.whatsappReach("lixo", "5531999999999"), "ok");        // usa o normalizado do banco
  assert.equal(phone.whatsappReach(null), "no_phone");
  assert.equal(phone.whatsappReach("   "), "no_phone");
  assert.equal(phone.whatsappReach("(31) 3222-1234"), "landline");
  assert.equal(phone.whatsappReach("123"), "invalid");
  assert.equal(phone.whatsappReach("31 9999-9999"), "invalid");            // celular sem o 9: não inventamos o dígito
});

test("mensagem no SINGULAR: quem fala é a profissional, nunca uma equipe (todas as 8 variações)", () => {
  const coletivo = /esperamos|aguardamos|a gente|estamos|vamos|nossa|nosso|conosco|nós/i;
  const seen = new Set();
  for (let i = 0; i < 400 && seen.size < msg.CONFIRMATION_VARIANTS; i++) {
    const seed = `sing-${i}`;
    if (seen.has(msg.confirmationVariant(seed))) continue;
    seen.add(msg.confirmationVariant(seed));
    const m = msg.buildConfirmationMessage({ ...base, variantSeed: seed });
    assert.doesNotMatch(m, coletivo, m);
  }
  assert.equal(seen.size, 8);
});

// ---------------- opção 2: mensagem própria da empresa
const tpl = load("lib/hive/message-template.ts");

test("mensagem própria: variáveis trocadas; maiúsculas/acentos aceitos; mesma data/hora das variações", () => {
  const m = msg.buildConfirmationMessage({ ...base, customTemplate: "Olá {Nome}, seu {serviço} é {dia_semana}, {data}, às {HORÁRIO}. {negocio}" });
  assert.equal(m, "Olá Maria, seu Alongamento em gel é quinta-feira, 15/10, às 14h. Studio Bella");
});

test("mensagem própria: sem nome/serviço a pontuação fica limpa; quebras de linha preservadas", () => {
  const m = msg.buildConfirmationMessage({ ...base, clientName: "", serviceName: " ",
    customTemplate: "Olá {nome}!\r\nSeu horário {servico} : {data} às {horario} .\n\nObrigada!" });
  assert.equal(m, "Olá!\nSeu horário: 15/10 às 14h.\n\nObrigada!");
});

test("mensagem própria inválida (variável desconhecida ou sem data/horário): usa as variações do sistema", () => {
  for (const bad of ["Olá {nome}, {data} {horario} {cupom}", "Olá {nome}, te espero!", "   ", null]) {
    const m = msg.buildConfirmationMessage({ ...base, variantSeed: "x", customTemplate: bad });
    assert.equal(m, msg.buildConfirmationMessage({ ...base, variantSeed: "x" }), String(bad));
  }
});

test("validação da mensagem própria: mensagens claras", () => {
  assert.deepEqual(tpl.confirmationTemplateProblems(tpl.DEFAULT_CUSTOM_TEMPLATE), []);
  assert.deepEqual(tpl.confirmationTemplateProblems(""), ["Escreva a mensagem."]);
  assert.match(tpl.confirmationTemplateProblems("{data} {horario} {cupom} {Promo}").join(" "), /desconhecida: \{cupom\}, \{Promo\}/);
  assert.match(tpl.confirmationTemplateProblems("Olá {nome}").join(" "), /Inclua \{data\} e \{horario\}/);
  assert.match(tpl.confirmationTemplateProblems("{data}{horario}" + "x".repeat(1000)).join(" "), /1000 caracteres/);
  assert.equal(tpl.normalizeVariable("Serviço"), "servico");
});
