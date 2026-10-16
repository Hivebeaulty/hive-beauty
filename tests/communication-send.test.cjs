// Central de comunicação — envio pelo WhatsApp (0028): regras puras da tela.
// As regras reais (autorização, limites, espaçamento) estão no banco:
// supabase/tests/local/0028_local.sh.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const c = load("lib/hive/communication.ts");

test("prévia = texto enviado: variáveis + rodapé de saída", () => {
  assert.equal(c.campaignMessage("  Oi {Nome}! Novidades no {negocio}.  ", { clientName: "Ana Maria", companyName: "Studio Bella" }),
    "Oi Ana! Novidades no Studio Bella.\n\nPara não receber mais mensagens, responda SAIR.");
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
