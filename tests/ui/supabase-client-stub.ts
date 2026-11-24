// Substitui @/lib/supabase/client no palco de testes. O painel W3 recebe a API
// simulada por propriedade e nunca deve chamar o Supabase. Componentes que usam
// o cliente direto (W5) só funcionam quando o TESTE instala window.__rpc; sem
// isso, qualquer uso continua sendo erro (nunca há Supabase de verdade aqui).
//
// Agenda: o teste instala window.__db (tabelas em memória). Aí o cliente também
// tem .from(tabela) com os filtros que a Agenda usa (select, eq, in, is, or, gte,
// gt, lt, lte, order), registra cada consulta em __db.calls e responde depois de
// __db.delay(consulta) ms. Também grava (insert, update, delete — ex.: bloqueio de
// horário), com single()/maybeSingle(); cada gravação aparece em __db.calls com
// op e payload. Também simula rpc e functions.invoke (Assinatura).
type Rpc = (fn: string, args: unknown) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
type Filter = [op: string, column: string, value: unknown];
type Call = { table: string; select: string; filters: Filter[]; op?: "insert" | "update" | "delete"; payload?: unknown };
type Db = {
  tables: Record<string, Record<string, unknown>[]>;
  rpc?: Record<string, unknown>;
  calls: Call[];
  delay?: (call: Call) => number;
  fail?: (call: Call) => boolean;
  invoke?: (name: string, body: unknown) => { data: unknown; error: unknown };
  signIn?: (creds: unknown) => { data: unknown; error: unknown };
};

const asTime = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
function matches(row: Record<string, unknown>, [op, col, value]: Filter) {
  const a = asTime(row[col]) as number | string;
  const b = asTime(value) as number | string;
  if (op === "eq") return row[col] === value;
  if (op === "is") return value === null ? row[col] == null : row[col] === value;
  if (op === "or") {
    // "professional_member_id.eq.m2,professional_member_id.is.null"
    return String(value)
      .split(",")
      .some((cond) => {
        const [c, o, ...rest] = cond.split(".");
        const v = rest.join(".");
        return o === "is" ? (v === "null" ? row[c] == null : row[c] === v) : row[c] === v;
      });
  }
  if (op === "in") return (value as unknown[]).includes(row[col]);
  if (op === "gte") return a >= b;
  if (op === "gt") return a > b;
  if (op === "lte") return a <= b;
  if (op === "lt") return a < b;
  return true;
}

function from(db: Db, table: string) {
  const call: Call = { table, select: "", filters: [] };
  let one: "single" | "maybe" | null = null;
  let seq = 0;
  const add = (op: string) => (column: string, value: unknown) => {
    call.filters.push([op, column, value]);
    return builder;
  };
  const builder = {
    select(cols: string) {
      call.select = cols;
      return builder;
    },
    insert(payload: unknown) {
      call.op = "insert";
      call.payload = payload;
      return builder;
    },
    update(payload: unknown) {
      call.op = "update";
      call.payload = payload;
      return builder;
    },
    delete() {
      call.op = "delete";
      return builder;
    },
    single() {
      one = "single";
      return builder;
    },
    maybeSingle() {
      one = "maybe";
      return builder;
    },
    is: add("is"),
    or(expr: string) {
      call.filters.push(["or", "", expr]);
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
          const all = (db.tables[table] ??= []);
          let rows: Record<string, unknown>[];
          if (call.op === "insert") {
            const list = Array.isArray(call.payload) ? call.payload : [call.payload];
            rows = list.map((r) => ({ id: `novo-${++seq}`, ...(r as object) }));
            all.push(...rows);
          } else {
            rows = all.filter((row) => call.filters.every((f) => matches(row, f)));
            if (call.op === "update") rows.forEach((r) => Object.assign(r, call.payload));
            if (call.op === "delete") db.tables[table] = all.filter((r) => !rows.includes(r));
          }
          const out = rows.map((r) => ({ ...r }));
          if (one) {
            if (!out.length && one === "single") return { data: null, error: { code: "PGRST116", message: "nenhuma linha" } };
            return { data: out[0] ?? null, error: null };
          }
          return { data: out, error: null };
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
      // auth.signInWithPassword: registra a chamada; o teste pode instalar __db.signIn
      auth: {
        signInWithPassword: async (creds: unknown) => {
          db.calls.push({ table: "auth:signIn", select: "", filters: [["creds", "", creds]] });
          return db.signIn ? db.signIn(creds) : { data: {}, error: null };
        },
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
