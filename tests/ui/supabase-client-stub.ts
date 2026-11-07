// Substitui @/lib/supabase/client no palco de testes. O painel W3 recebe a API
// simulada por propriedade e nunca deve chamar o Supabase. Componentes que usam
// o cliente direto (W5) só funcionam quando o TESTE instala window.__rpc; sem
// isso, qualquer uso continua sendo erro (nunca há Supabase de verdade aqui).
//
// Agenda: o teste instala window.__db (tabelas em memória). Aí o cliente também
// tem .from(tabela) com os filtros que a Agenda usa (select, eq, in, gte, gt,
// lt, lte, order), registra cada consulta em __db.calls e responde depois de
// __db.delay(consulta) ms. Também simula rpc e functions.invoke (Assinatura).
type Rpc = (fn: string, args: unknown) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
type Filter = [op: string, column: string, value: unknown];
type Call = { table: string; select: string; filters: Filter[] };
type Db = {
  tables: Record<string, Record<string, unknown>[]>;
  rpc?: Record<string, unknown>;
  calls: Call[];
  delay?: (call: Call) => number;
  fail?: (call: Call) => boolean;
  invoke?: (name: string, body: unknown) => { data: unknown; error: unknown };
};

const asTime = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
function matches(row: Record<string, unknown>, [op, col, value]: Filter) {
  const a = asTime(row[col]) as number | string;
  const b = asTime(value) as number | string;
  if (op === "eq") return row[col] === value;
  if (op === "in") return (value as unknown[]).includes(row[col]);
  if (op === "gte") return a >= b;
  if (op === "gt") return a > b;
  if (op === "lte") return a <= b;
  if (op === "lt") return a < b;
  return true;
}

function from(db: Db, table: string) {
  const call: Call = { table, select: "", filters: [] };
  const add = (op: string) => (column: string, value: unknown) => {
    call.filters.push([op, column, value]);
    return builder;
  };
  const builder = {
    select(cols: string) {
      call.select = cols;
      return builder;
    },
    eq: add("eq"),
    in: add("in"),
    gte: add("gte"),
    gt: add("gt"),
    lte: add("lte"),
    lt: add("lt"),
    order() {
      return builder;
    },
    then<T>(resolve: (r: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) {
      db.calls.push(call);
      const ms = db.delay?.(call) ?? 20;
      return new Promise((r) => setTimeout(r, ms))
        .then(() => {
          if (db.fail?.(call)) return { data: null, error: { message: "falha simulada" } };
          const rows = (db.tables[table] ?? []).filter((row) => call.filters.every((f) => matches(row, f)));
          return { data: rows.map((r) => ({ ...r })), error: null };
        })
        .then(resolve, reject);
    },
  };
  return builder;
}

export function createClient() {
  const w = window as unknown as { __rpc?: Rpc; __db?: Db };
  const db = w.__db;
  if (db) {
    return {
      from: (table: string) => from(db, table),
      // rpc: valor fixo, ou função (args) => { data, error } para respostas que mudam (ex.: depois de cancelar)
      rpc: async (fn: string, args?: unknown) => {
        db.calls.push({ table: `rpc:${fn}`, select: "", filters: [["args", "", args]] });
        const v = db.rpc?.[fn];
        return typeof v === "function" ? (v as (a: unknown) => { data: unknown; error: unknown })(args) : { data: v ?? null, error: null };
      },
      // functions.invoke: o teste instala __db.invoke(nome, corpo) => { data, error }
      functions: {
        invoke: async (name: string, opts?: { body?: unknown }) => {
          db.calls.push({ table: `fn:${name}`, select: "", filters: [["body", "", opts?.body]] });
          await new Promise((r) => setTimeout(r, 30));
          return db.invoke ? db.invoke(name, opts?.body) : { data: null, error: { message: "sem função" } };
        },
      },
    };
  }
  const rpc = w.__rpc;
  if (!rpc) throw new Error("Supabase real não deve ser usado no palco de testes");
  return { rpc };
}
