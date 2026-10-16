// Paridade: o texto montado pelo BANCO (whatsapp_private.confirmation_text, 0018)
// tem de ser IDÊNTICO ao da tela (buildConfirmationMessage, lib/hive/appointment-message.ts)
// para os mesmos dados. Gera casos variados, grava num Postgres LOCAL (transação
// desfeita no fim), pede o texto ao banco e compara com o TS.
// Uso: node 0018_message_parity.cjs <banco>   (chamado por 0018_message_parity_local.sh)
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "../../..");
const { load } = require(path.join(ROOT, "tests/load-ts.cjs"));
const msg = load(path.join(ROOT, "lib/hive/appointment-message.ts"));
const names = load(path.join(ROOT, "lib/hive/display-name.ts"));
const DB = process.argv[2];
const tplmod = load(path.join(ROOT, "lib/hive/message-template.ts"));
if (!DB) throw new Error("informe o banco local");

const clients = ["Ana Maria Lima", "  Beatriz  ", "José", "Ana", "Maria  das   Dores", "Ágata Ñuñez", "Lu 💅 Silva", "x"];
const services = ["Manicure", "  Escova progressiva ", "Pé e mão", "Design de sobrancelha", "Unha em gel ✨"];
const durations = [15, 30, 45, 60, 65, 90, 120, 125, 600];
const displays = [null, "Paty", "  Dra.   Ju  ", "", "Nome de exibição com quarenta letras ok", "studio bella"];
const fulls = [null, "Patrícia Souza", "Carla", "  Joana   Dark "];
const businesses = ["Studio Bella", "studio bella", "Espaço Áurea", "Carla"];
// instantes (UTC) e "agora" relativos: mesmo dia, véspera, longe; inclui virada de dia em SP
// opção 2 (mensagem própria): em parte dos casos; a última é INVÁLIDA (deve cair nas variações nos dois lados)
const templates = [
  null,
  "Olá {nome}! Seu horário de {servico} está confirmado para {dia_semana}, {data}, às {horario}.\n\nPara remarcações, o prazo mínimo é de 24h.\n\nObrigada!",
  "Oi {Nome} , tudo certo: {SERVIÇO} em {data} às {HORÁRIO} ({negocio}) !",
  "{nome}\r\n{data}   {horario}  ;  {dia_semana}",
  "Oi {nome}, {data} {horario} {cupom}",
];
const starts = ["2026-10-15T17:00:00Z", "2026-10-16T02:30:00Z", "2026-10-15T12:05:00Z", "2026-12-31T23:45:00Z", "2027-01-01T03:00:00Z", "2026-11-02T10:00:00Z"];
const nowsFor = (iso) => {
  const t = Date.parse(iso);
  return [t - 3600e3, t - 26 * 3600e3, t - 9 * 86400e3, t - 20 * 3600e3].map((x) => new Date(x).toISOString());
};

let seq = 0;
const cases = [];
for (const s of starts) for (const now of nowsFor(s)) {
  for (let k = 0; k < 6; k++) {
    seq++;
    const pick = (arr) => arr[(seq * 7 + k * 3) % arr.length];
    cases.push({
      n: seq,
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      client: pick(clients), service: pick(services), duration: durations[(seq + k) % durations.length],
      display: displays[(seq + 2 * k) % displays.length], full: fulls[(seq + k) % fulls.length],
      business: businesses[(seq * 3 + k) % businesses.length], start: s, now,
      template: templates[(seq + 2 * k) % templates.length],
    });
  }
}

const lit = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
let sql = "begin;\nset local client_min_messages = warning;\ncreate temp table zz_out (n int, txt text) on commit drop;\n";
for (const c of cases) {
  const email = `parity-${c.n}@teste.local`;
  sql += `do $$ declare u uuid; co uuid; m uuid; sv uuid; cl uuid; begin
  insert into auth.users (email) values (${lit(email)}) returning id into u;
  update profiles set full_name = ${lit(c.full)}, display_name = ${lit(c.display === "" ? null : c.display)} where id = u;
  insert into companies (name) values (${lit(c.business)}) returning id into co;
  insert into company_members (company_id, user_id, role) values (co, u, 'professional') returning id into m;
  insert into services (company_id, name, duration_minutes) values (co, ${lit(c.service)}, ${c.duration}) returning id into sv;
  insert into clients (company_id, name) values (co, ${lit(c.client)}) returning id into cl;
  insert into appointments (id, company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
    values ('${c.id}', co, cl, sv, m, '${c.start}', timestamptz '${c.start}' + interval '${c.duration} minutes', 10);
  ${c.template === null ? "" : `insert into whatsapp_private.message_templates (company_id, confirmation_mode, confirmation_template) values (co, 'custom', ${lit(c.template)});`}
  insert into zz_out values (${c.n}, whatsapp_private.confirmation_text('${c.id}', '${c.now}'));
end $$;\n`;
}
sql += "select json_agg(json_build_object('n', n, 'txt', txt) order by n) from zz_out;\nrollback;\n";

const out = execFileSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", DB], { input: sql, encoding: "utf8" });
const rows = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
const bySeq = new Map(rows.map((r) => [r.n, r.txt]));
let pass = 0, fail = 0;
const variants = new Set();
for (const c of cases) {
  const expected = msg.buildConfirmationMessage({
    clientName: c.client,
    startsAt: new Date(c.start),
    durationMinutes: c.duration,
    serviceName: c.service,
    professionalName: names.resolveSignatureName({ displayName: c.display, fullName: c.full }),
    businessName: c.business,
    now: new Date(c.now),
    variantSeed: c.id,
    customTemplate: c.template,
  });
  variants.add(msg.confirmationVariant(c.id));
  if (bySeq.get(c.n) === expected) pass++;
  else {
    fail++;
    if (fail <= 5) console.log(`FAIL caso ${c.n}\n--- TS\n${expected}\n--- SQL\n${bySeq.get(c.n)}\n`);
  }
}
const ok = (cond, label) => { if (cond) { pass++; console.log(`PASS ${label}`); } else { fail++; console.log(`FAIL ${label}`); } };
const customValid = cases.filter((c) => c.template && tplmod.confirmationTemplateProblems(c.template).length === 0).length;
const customInvalid = cases.filter((c) => c.template && tplmod.confirmationTemplateProblems(c.template).length > 0).length;
ok(customValid >= 60 && customInvalid >= 20, `P-tpl mensagens próprias exercitadas: ${customValid} válidas e ${customInvalid} inválidas (caem nas variações)`);
ok(variants.size === msg.CONFIRMATION_VARIANTS, `P-var as ${msg.CONFIRMATION_VARIANTS} variações aparecem nos casos (${[...variants].sort().join(",")})`);
console.log(`${fail === 0 ? "INFO" : "FAIL"} ${cases.length} casos comparados; divergentes: ${cases.length - (pass - 2)}`);
console.log(`RESULTADO paridade 0018: PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
