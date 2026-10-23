// Ficha da cliente: próximos atendimentos x histórico, e a mensagem com todos
// os próximos horários (serviços e datas no fuso do negócio).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const u = load("lib/hive/upcoming-message.ts");

// quinta-feira, 22/10/2026, 15h em Brasília (18h UTC)
const NOW = new Date("2026-10-22T18:00:00Z");
const at = (iso) => ({ scheduled_start: iso });

test("próximos: só agendado/confirmado a partir de agora, do mais perto para o mais longe", () => {
  const list = [
    { id: "futuro-longe", ...at("2026-11-05T13:00:00Z"), status: "agendado" },
    { id: "futuro-perto", ...at("2026-10-23T12:00:00Z"), status: "confirmado" },
    { id: "passado", ...at("2026-10-01T12:00:00Z"), status: "concluido" },
    { id: "futuro-cancelado", ...at("2026-10-30T12:00:00Z"), status: "cancelado" },
    { id: "agora-em-atendimento", ...at("2026-10-22T17:30:00Z"), status: "em_atendimento" },
    { id: "atrasado-sem-baixa", ...at("2026-10-22T12:00:00Z"), status: "agendado" },
  ];
  const { upcoming, past } = u.splitAppointments(list, NOW);
  assert.deepEqual(upcoming.map((a) => a.id), ["futuro-perto", "futuro-longe"]);
  // histórico: todo o resto, do mais novo para o mais antigo
  assert.deepEqual(past.map((a) => a.id), ["futuro-cancelado", "agora-em-atendimento", "atrasado-sem-baixa", "passado"]);
});

test("serviços: principal + adicionais na ordem gravada", () => {
  assert.equal(u.appointmentServicesLabel("Manicure", []), "Manicure");
  assert.equal(
    u.appointmentServicesLabel("Manicure", [{ position: 2, name: "Esmaltação" }, { position: 1, name: "Pedicure" }]),
    "Manicure, Pedicure e Esmaltação"
  );
  assert.equal(u.appointmentServicesLabel(null, [{ position: 1, name: "Pedicure" }]), "Pedicure");
});

test("mensagem com vários horários: saudação pelo primeiro nome, lista em ordem, dia e hora em Brasília", () => {
  const msg = u.buildUpcomingMessage({
    clientName: "Ana Paula Souza",
    now: NOW,
    items: [
      { startsAt: "2026-11-05T12:30:00Z", serviceName: "Design de sobrancelha" }, // 05/11 9h30
      { startsAt: "2026-10-23T17:00:00Z", serviceName: "Manicure e Pedicure" }, // amanhã 14h
    ],
  });
  assert.equal(
    msg,
    "Oi, Ana, tudo bem?\n\nPassando para te lembrar dos seus próximos horários:\n\n" +
      "• amanhã, sexta-feira (23/10), às 14h — Manicure e Pedicure\n" +
      "• quinta-feira, 05/11, às 9h30 — Design de sobrancelha\n\n" +
      "Se precisar remarcar algum, é só me avisar por aqui. 💕"
  );
});

test("mensagem com um horário usa o singular; hoje aparece como hoje", () => {
  const msg = u.buildUpcomingMessage({ clientName: "Bia", now: NOW, items: [{ startsAt: "2026-10-22T21:00:00Z", serviceName: "Escova" }] });
  assert.match(msg, /do seu próximo horário:/);
  assert.match(msg, /• hoje, quinta-feira \(22\/10\), às 18h — Escova/);
  assert.match(msg, /Se precisar remarcar, é só me avisar/);
  assert.doesNotMatch(msg, /remarcar algum/);
});

test("horário perto da meia-noite não vira o dia (fuso do negócio, não UTC)", () => {
  // 23/10 às 23h em Brasília = 24/10 02h UTC
  const msg = u.buildUpcomingMessage({ clientName: "Ana", now: NOW, items: [{ startsAt: "2026-10-24T02:00:00Z", serviceName: "Unhas" }] });
  assert.match(msg, /\(23\/10\), às 23h/);
});

test("sem nome: saudação neutra; sem serviço: só data e hora; lista vazia: texto vazio", () => {
  const msg = u.buildUpcomingMessage({ clientName: "", now: NOW, items: [{ startsAt: "2026-11-05T13:00:00Z", serviceName: "  " }] });
  assert.match(msg, /^Oi, tudo bem\?/);
  assert.match(msg, /• quinta-feira, 05\/11, às 10h\n/);
  assert.equal(u.buildUpcomingMessage({ clientName: "Ana", items: [], now: NOW }), "");
});

test("muitos horários: lista os primeiros e resume o resto, sem passar do limite do WhatsApp", () => {
  const items = Array.from({ length: 40 }, (_, k) => ({
    startsAt: new Date(Date.UTC(2026, 10, 1 + k, 13)).toISOString(),
    serviceName: "Manicure, Pedicure e Esmaltação em gel com decoração",
  }));
  const msg = u.buildUpcomingMessage({ clientName: "Ana", items, now: NOW });
  assert.equal((msg.match(/^• /gm) ?? []).length, u.MAX_MESSAGE_ITEMS + 1);
  assert.match(msg, /• e mais 25 horários já agendados/);
  assert.ok(msg.length < 4096);
});

test("tom: primeira pessoa do singular, sem assinatura, no máximo 1 emoji", () => {
  const msg = u.buildUpcomingMessage({ clientName: "Ana", now: NOW, items: [{ startsAt: "2026-11-05T13:00:00Z", serviceName: "Unhas" }] });
  assert.doesNotMatch(msg, /\b(nós|esperamos|a gente|equipe)\b/i);
  assert.match(msg, /me avisar/);
  assert.equal([...msg.matchAll(/\p{Extended_Pictographic}/gu)].length, 1);
});

test("chave de envio: mesmo texto no mesmo dia repete a chave (sem mensagem em dobro); muda com texto, dia ou cliente", () => {
  const k = u.upcomingSendKey("c1", "texto", NOW);
  assert.equal(k, u.upcomingSendKey("c1", "  texto \n", NOW));
  assert.notEqual(k, u.upcomingSendKey("c1", "texto editado", NOW));
  assert.notEqual(k, u.upcomingSendKey("c2", "texto", NOW));
  assert.notEqual(k, u.upcomingSendKey("c1", "texto", new Date("2026-10-23T18:00:00Z")));
  // o dia é o de Brasília: 22/10 às 23h30 (23/10 02h30 UTC) ainda é 22/10
  assert.equal(k, u.upcomingSendKey("c1", "texto", new Date("2026-10-23T02:30:00Z")));
  assert.match(k, /^upcoming:c1:2026-10-22:/);
});

test("erros do banco viram texto claro", () => {
  assert.match(u.sendErrorMessage("AUW01"), /não está conectado/);
  assert.match(u.sendErrorMessage("AUW02", "blocked"), /pediu para não receber/);
  assert.match(u.sendErrorMessage("AUW02", "landline"), /celular válido/);
  assert.match(u.sendErrorMessage("AUW03"), /Limite/);
  assert.match(u.sendErrorMessage("xyz"), /Não foi possível enviar/);
});
