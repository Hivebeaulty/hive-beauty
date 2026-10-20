const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const bulk = load("lib/hive/bulk-clients.ts");

test("chunk: divide em blocos e não perde nem repete ninguém", () => {
  const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
  const parts = bulk.chunk(ids, 100);
  assert.deepEqual(parts.map((p) => p.length), [100, 100, 50]);
  assert.deepEqual(parts.flat(), ids);
  assert.deepEqual(bulk.chunk([], 100), []);
});

test("mapWithLimit: respeita o limite de chamadas simultâneas e mantém a ordem", async () => {
  let running = 0;
  let peak = 0;
  const out = await bulk.mapWithLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 * (9 - n)));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.ok(peak <= 3 && peak >= 2, `pico ${peak}`);
  assert.deepEqual(await bulk.mapWithLimit([], 4, async (x) => x), []);
});

test("keepVisibleSelection: só fica selecionado quem ainda está na lista", () => {
  const next = bulk.keepVisibleSelection(new Set(["a", "b", "c"]), ["b", "c", "d"]);
  assert.deepEqual([...next].sort(), ["b", "c"]);
  assert.equal(bulk.keepVisibleSelection(new Set(["a"]), []).size, 0);
});

test("planBulkDelete: sem histórico exclui; com histórico inativa; já inativa com histórico não muda", () => {
  const plan = bulk.planBulkDelete([
    { id: "sem", archived: false, appointments: 0, payments: 0 },
    { id: "sem-inativa", archived: true, appointments: 0, payments: 0 },
    { id: "atend", archived: false, appointments: 2, payments: 0 },
    { id: "pag", archived: false, appointments: 0, payments: 1 },
    { id: "hist-inativa", archived: true, appointments: 3, payments: 3 },
  ]);
  assert.deepEqual(plan.toDelete, ["sem", "sem-inativa"]);
  assert.deepEqual(plan.toInactivate, ["atend", "pag"]);
  assert.deepEqual(plan.untouched, ["hist-inativa"]);
  // nenhuma cliente aparece em dois grupos
  const all = [...plan.toDelete, ...plan.toInactivate, ...plan.untouched];
  assert.equal(new Set(all).size, 5);
});

test("plural", () => {
  assert.equal(bulk.plural(1, "cliente", "clientes"), "cliente");
  assert.equal(bulk.plural(0, "cliente", "clientes"), "clientes");
  assert.equal(bulk.plural(2, "cliente", "clientes"), "clientes");
});
