const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const comm = load("lib/hive/communication.ts");

const c = (phone, phone_normalized, comm_status) => ({ phone, phone_normalized, comm_status });

test("elegibilidade: prioridade e motivos", () => {
  assert.equal(comm.recipientBlock(c("11999990000", "5511999990000", "allowed")), null);
  // quem bloqueou é respeitada antes de qualquer outra coisa
  assert.equal(comm.recipientBlock(c("11999990000", "5511999990000", "blocked")), "blocked");
  assert.equal(comm.recipientBlock(c(null, null, "blocked")), "blocked");
  assert.equal(comm.recipientBlock(c(null, null, "allowed")), "no_phone");
  assert.equal(comm.recipientBlock(c("  ", null, "allowed")), "no_phone");
  assert.equal(comm.recipientBlock(c("123", null, "allowed")), "invalid_phone");
  assert.equal(comm.recipientBlock(c("1132221234", "551132221234", "allowed")), "landline");
  // autorização não informada NÃO é autorizada
  assert.equal(comm.recipientBlock(c("11999990000", "5511999990000", "unknown")), "consent_unknown");
});

test("resumo do público soma certo", () => {
  const s = comm.summarizeAudience([
    c("11999990000", "5511999990000", "allowed"),
    c("11988887777", "5511988887777", "allowed"),
    c("11977776666", "5511977776666", "unknown"),
    c(null, null, "allowed"),
    c("123", null, "allowed"),
    c("1132221234", "551132221234", "allowed"),
    c("11955554444", "5511955554444", "blocked"),
  ]);
  assert.deepEqual(s, {
    total: 7, reachable: 2, blocked: 1, noPhone: 1, invalidPhone: 1, landline: 1, consentUnknown: 1,
  });
});

test("modelo de mensagem", () => {
  const ctx = { clientName: "Maria da Silva", companyName: "Studio Bella" };
  assert.equal(comm.renderTemplate("Oi {nome}! Aqui é o {negocio}.", ctx), "Oi Maria! Aqui é o Studio Bella.");
  assert.equal(comm.renderTemplate("{nome} e {nome}", ctx), "Maria e Maria");
  // variável desconhecida fica visível, não some
  assert.equal(comm.renderTemplate("Oi {apelido}", ctx), "Oi {apelido}");
  assert.deepEqual(comm.findUnknownVariables("Oi {nome} {apelido} {apelido} {x_y}"), ["apelido", "x_y"]);
  assert.deepEqual(comm.findUnknownVariables("Oi {nome}"), []);
});

// ---- Auditoria final: matriz completa de consentimento x telefone -----------
test("auditoria: só 'allowed' + celular válido é elegível (matriz completa)", () => {
  const phones = [
    ["sem telefone (null)", null, null],
    ["sem telefone (vazio)", "", null],
    ["inválido", "123", null],
    ["fixo", "3132221234", "553132221234"],
    ["celular", "31999999999", "5531999999999"],
  ];
  for (const status of ["unknown", "allowed", "blocked"]) {
    for (const [label, ph, norm] of phones) {
      const block = comm.recipientBlock({ phone: ph, phone_normalized: norm, comm_status: status });
      const eligible = block === null;
      const expected = status === "allowed" && label === "celular";
      assert.equal(eligible, expected, `${status} + ${label} -> ${block}`);
      if (status === "blocked") assert.equal(block, "blocked", `${label}: quem bloqueou nunca é elegível`);
      if (status === "unknown" && label === "celular") assert.equal(block, "consent_unknown");
    }
  }
  // valor inesperado/ausente de consentimento NUNCA vira elegível
  for (const weird of [undefined, null, "", "ALLOWED", "yes", true]) {
    assert.notEqual(comm.recipientBlock({ phone: "31999999999", phone_normalized: "5531999999999", comm_status: weird }), null, String(weird));
  }
});

test("auditoria: {Nome} e {NEGOCIO} em maiúscula também funcionam; desconhecida é avisada", () => {
  const ctx = { clientName: "Ana Paula", companyName: "Studio Luz" };
  assert.equal(comm.renderTemplate("Oi {Nome}, {NEGOCIO}", ctx), "Oi Ana, Studio Luz");
  assert.deepEqual(comm.findUnknownVariables("{Nome} {Apelido}"), ["Apelido"]);
  // valor de nome que parece variável não é reinterpretado
  assert.equal(comm.renderTemplate("{nome}", { clientName: "{negocio}", companyName: "X" }), "{negocio}");
});
