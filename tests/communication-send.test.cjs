// Central de comunicação — envio pelo WhatsApp (0028): regras puras da tela.
// As regras reais (autorização, limites, espaçamento) estão no banco:
// supabase/tests/local/0028_local.sh.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const c = load("lib/hive/communication.ts");

test("prévia = texto enviado: só a mensagem da profissional, com as variáveis trocadas", () => {
  assert.equal(c.campaignMessage("  Oi {Nome}! Novidades no {negocio}.  ", { clientName: "Ana Maria", companyName: "Studio Bella" }),
    "Oi Ana! Novidades no Studio Bella.");
});

test("NENHUM rodapé é acrescentado (exemplo do pedido, texto sem variáveis)", () => {
  const texto = "Oi Tainá, se vc recebeu essa mensagem vc é trouxa";
  assert.equal(c.campaignMessage(texto, { clientName: "Tainá do Carmo", companyName: "Studio" }), texto);
  assert.doesNotMatch(c.campaignMessage("Oi {nome}\n\nLinha 2", { clientName: "Ana", companyName: "X" }), /SAIR|não receber/i);
});

test("botão de envio: explica por que está desligado; só libera quando tudo está certo", () => {
  assert.match(c.sendBlockReason(false, true, 3, "Oi", 0), /administração/);
  assert.match(c.sendBlockReason(true, null, 3, "Oi", 0), /Verificando/);
  assert.match(c.sendBlockReason(true, false, 3, "Oi", 0), /Conecte o WhatsApp/);
  assert.match(c.sendBlockReason(true, true, 0, "Oi", 0), /Selecione/);
  assert.match(c.sendBlockReason(true, true, 3, "   ", 0), /Escreva/);
  assert.match(c.sendBlockReason(true, true, 3, "Oi {x}", 1), /variáveis/);
  assert.match(c.sendBlockReason(true, true, 3, "x".repeat(1001), 0), /1000/);
  assert.equal(c.sendBlockReason(true, true, 3, "Oi {nome}", 0), null);
});

test("erros do envio: claros e sempre dizendo que nada foi enviado", () => {
  for (const code of ["AUW01", "AUW02", "AUW03", "AUW05", "AUW06", "XX", undefined]) {
    const m = c.campaignErrorMessage(code, "Limite diário de mensagens: hoje ainda dá para enviar para 4 cliente(s).");
    assert.match(m, /[Nn]ada foi enviado/, String(code));
  }
  assert.match(c.campaignErrorMessage("AUW03", "Limite diário: 4."), /Limite diário: 4\./);
  assert.match(c.campaignErrorMessage("42501", ""), /administração/);
});

test("tela da central: sem o aviso fixo de 'envio indisponível' nem menção ao rodapé de SAIR", () => {
  const fs = require("node:fs");
  const page = fs.readFileSync(require("node:path").join(__dirname, "../app/(app)/clientes/comunicacao/page.tsx"), "utf8");
  assert.doesNotMatch(page, /ainda não está disponível|Envio indisponível|Nada é enviado/);
  assert.doesNotMatch(page, /responda SAIR/);
  // avisos legítimos continuam: WhatsApp desconectado e falha no envio
  assert.match(c.sendBlockReason(true, false, 1, "Oi", 0), /Conecte o WhatsApp/);
  assert.match(c.campaignErrorMessage("AUW01", ""), /não está conectado/);
});
