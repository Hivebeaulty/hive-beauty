// Vários serviços no mesmo atendimento — regras puras (o banco confere: 0033_local.sh).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const x = load("lib/hive/extra-services.ts");
const S = (id, price, m) => ({ service_id: id, price, duration_minutes: m });

test("totais: soma valor e duração do principal + adicionais", () => {
  assert.deepEqual(x.totals({ price: 50, minutes: 60 }, []), { price: 50, minutes: 60 });
  assert.deepEqual(x.totals({ price: 50, minutes: 60 }, [S("b", 60.1, 45), S("c", 19.9, 15)]), { price: 130, minutes: 120 });
});

test("lista de nomes igual à do banco", () => {
  assert.equal(x.servicesLabel(["Manicure"]), "Manicure");
  assert.equal(x.servicesLabel(["Manicure", " Pedicure "]), "Manicure e Pedicure");
  assert.equal(x.servicesLabel(["Manicure", "Pedicure", "Esmaltação"]), "Manicure, Pedicure e Esmaltação");
  assert.equal(x.servicesLabel(["Manicure", "", null]), "Manicure");
});

test("validação e comparação dos adicionais", () => {
  assert.equal(x.extraItemsProblem([S("b", 10, 15)]), null);
  assert.match(x.extraItemsProblem([S("", 10, 15)]), /Escolha/);
  assert.match(x.extraItemsProblem([S("b", -1, 15)]), /Valor/);
  assert.match(x.extraItemsProblem(Array.from({ length: 11 }, () => S("b", 1, 1))), /10/);
  assert.equal(x.sameExtras([S("b", 10, 15)], [S("b", "10", 15)]), true);
  assert.equal(x.sameExtras([S("b", 10, 15)], [S("b", 11, 15)]), false);
});

test("relatórios: adicionais com o valor deles; principal com o restante, nunca negativo", () => {
  assert.deepEqual(x.splitRevenue(130, [{ price: 60 }, { price: "20" }]), { primary: 50, extras: [60, 20] });
  assert.deepEqual(x.splitRevenue(50, [{ price: 80 }]), { primary: 0, extras: [80] });
});

test("rankings: adicional conta no próprio serviço; principal fica com o restante; total da cliente igual", () => {
  const r = load("lib/hive/rankings.ts");
  const row = (id, price, extras) => ({ id, scheduled_start: "2026-10-10T13:00:00Z", scheduled_end: "2026-10-10T15:00:00Z", price,
    client_id: "c1", service_id: "mani", clients: { name: "Ana" }, services: { name: "Manicure" }, appointment_extra_services: extras });
  const { services, clients } = r.buildRankings([
    row("a1", 130, [{ service_id: "pedi", price: 60, duration_minutes: 45, services: { name: "Pedicure" } }, { service_id: "esm", price: "20", duration_minutes: 15, services: [{ name: "Esmaltação" }] }]),
    row("a2", 50, null),
  ]);
  const by = Object.fromEntries(services.map((s) => [s.id, s]));
  assert.equal(by.mani.count, 2); assert.equal(by.mani.revenue, 100);     // 50 (a1) + 50 (a2)
  assert.equal(by.pedi.count, 1); assert.equal(by.pedi.revenue, 60);
  assert.equal(by.esm.revenue, 20); assert.equal(by.esm.name, "Esmaltação");
  assert.equal(by.mani.minutes, 60 + 120);                                // a1: 120 - 60 de adicionais; a2: 120
  assert.equal(clients[0].revenue, 180); assert.equal(clients[0].visits, 2);
});
