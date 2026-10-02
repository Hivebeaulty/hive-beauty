// O app é usado no Brasil; garante que os testes de data rodem nesse fuso,
// que é justamente onde new Date("AAAA-MM-DD") erra um dia.
process.env.TZ = "America/Sao_Paulo";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const fmt = load("lib/hive/format.ts");
const rel = load("lib/hive/relationship.ts");

test("data 'só dia' não anda um dia para trás no fuso do Brasil", () => {
  assert.equal(fmt.formatDateOnly("1990-03-15"), "15/03/1990");
  assert.equal(fmt.formatDateOnly("2026-01-01", { day: "2-digit", month: "long" }), "01 de janeiro");
  assert.equal(fmt.formatDateOnly(null), "—");
  assert.equal(fmt.formatDateOnly("lixo"), "—");
  // o comportamento antigo (bug) para registrar a diferença:
  assert.equal(new Date("1990-03-15").toLocaleDateString("pt-BR"), "14/03/1990");
});

test("aniversário: 0 = hoje, conta certo e dá a volta no ano", () => {
  const now = new Date(2026, 9, 1, 15, 0); // 01/10/2026 15:00 local
  assert.equal(rel.daysUntilNextBirthday("1990-10-01", now), 0);
  assert.equal(rel.daysUntilNextBirthday("1990-10-02", now), 1);
  assert.equal(rel.daysUntilNextBirthday("1990-09-30", now), 364);
  assert.equal(rel.daysUntilNextBirthday("1990-12-25", now), 85);
  assert.equal(rel.daysUntilNextBirthday(null, now), null);
});

const NOW = new Date(2026, 9, 1);
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

test("segmentos: fora_do_padrao exige histórico e é subconjunto de inativas", () => {
  // Vem a cada ~30 dias, última visita há 80 dias => passou de 1,5x (45)
  const late = rel.computeClientRelationship([daysAgo(140), daysAgo(110), daysAgo(80)], NOW);
  assert.equal(late.isOverdue, true);
  let segs = rel.classifySegments(late, null);
  assert.ok(segs.includes("fora_do_padrao") && segs.includes("inativas"));
  assert.ok(!segs.includes("recorrentes"));

  // Dentro do ritmo dela
  const ok = rel.computeClientRelationship([daysAgo(100), daysAgo(70), daysAgo(40)], NOW);
  segs = rel.classifySegments(ok, null);
  assert.ok(segs.includes("recorrentes"));
  assert.ok(!segs.includes("fora_do_padrao") && !segs.includes("inativas"));

  // 1 visita há 90 dias: regra fixa de 60 dias => inativa, mas SEM padrão próprio
  const one = rel.computeClientRelationship([daysAgo(90)], NOW);
  segs = rel.classifySegments(one, null);
  assert.ok(segs.includes("inativas"));
  assert.ok(!segs.includes("fora_do_padrao"));

  // Sem histórico: nova
  const none = rel.computeClientRelationship([], NOW);
  segs = rel.classifySegments(none, null);
  assert.deepEqual(segs, ["todas", "novas"]);
});

test("aniversariantes: até 30 dias", () => {
  const none = rel.computeClientRelationship([], NOW);
  assert.ok(rel.classifySegments(none, 30).includes("aniversariantes"));
  assert.ok(!rel.classifySegments(none, 31).includes("aniversariantes"));
});

// ---- Auditoria final: servidor em UTC (Vercel) -------------------------------
function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { process.env.TZ = prev; }
}

test("auditoria: servidor em UTC às 22h de Brasília ainda calcula o dia de Brasília", () => {
  // 02/10/2026 01:00 UTC = 01/10/2026 22:00 em Brasília
  const now = new Date("2026-10-02T01:00:00Z");
  for (const tz of ["UTC", "America/Sao_Paulo", "Asia/Tokyo"]) {
    withTZ(tz, () => {
      assert.equal(rel.daysUntilNextBirthday("1990-10-01", now), 0, `${tz}: aniversário de hoje (01/10 em Brasília)`);
      assert.equal(rel.daysUntilNextBirthday("1990-10-02", now), 1, `${tz}: amanhã`);
      assert.equal(rel.daysUntilNextBirthday("1990-09-30", now), 364, `${tz}: ontem já passou`);
    });
  }
  // 01/10 02:00 UTC = 30/09 23:00 em Brasília
  withTZ("UTC", () => {
    assert.equal(rel.daysUntilNextBirthday("1990-09-30", new Date("2026-10-01T02:00:00Z")), 0);
  });
});

test("auditoria: formatDateOnly e parseDateOnly iguais em qualquer fuso", () => {
  for (const tz of ["UTC", "America/Sao_Paulo", "Pacific/Kiritimati", "America/Los_Angeles"]) {
    withTZ(tz, () => {
      assert.equal(fmt.formatDateOnly("2026-03-01"), "01/03/2026", tz);
      assert.equal(fmt.formatDateOnly("1990-12-31", { day: "2-digit", month: "2-digit" }), "31/12", tz);
      const d = fmt.parseDateOnly("2026-03-01");
      assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 2, 1], tz);
    });
  }
});

test("auditoria: 29/02 em ano não bissexto vira 01/03; hoje no fuso do negócio", () => {
  const now = new Date("2026-02-27T15:00:00Z");
  assert.equal(rel.daysUntilNextBirthday("2000-02-29", now), 2); // 27/02 -> 01/03/2026
  assert.deepEqual(fmt.todayInBusinessTz(new Date("2026-10-02T01:00:00Z")), { y: 2026, m: 10, d: 1 });
});
