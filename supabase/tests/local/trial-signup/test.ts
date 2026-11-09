import { calls, cfg } from "./stub.ts";
for (const [k, v] of Object.entries({ SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "service-key-0123456789abcdef" })) Deno.env.set(k, v);
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
console.log = () => {};
const mod = await import("./index.ts"); const h = handler;
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = "") => { c ? pass++ : fail++; console.info((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); };
const APP = "https://hive-beauty.vercel.app";
const reset = () => { calls.length = 0; cfg.rpc = {}; cfg.createUser = { data: { user: { id: "u1" } }, error: null }; };
const post = (body: unknown, origin = APP, ip = "200.1.2.3") =>
  h(new Request("https://f/trial-signup", { method: "POST", headers: { origin, "x-forwarded-for": `${ip}, 10.0.0.1` }, body: JSON.stringify(body) }));
const good = { name: "  Ana   Paula ", email: " Ana@Exemplo.com ", password: "senha-forte", utm: { utm_source: "instagram", lixo: "x" } };
const fn = (name: string) => calls.find((c) => c[0] === name)?.[1] as any;

// entrada
reset(); { const r = await h(new Request("https://f", { method: "OPTIONS", headers: { origin: "https://socia-beauty.lovable.app" } }));
  check("CORS: a landing é aceita", r.headers.get("access-control-allow-origin") === "https://socia-beauty.lovable.app"); }
reset(); { const r = await post(good, "https://evil.com"); check("outra origem: 403 e nada criado", r.status === 403 && calls.length === 0); }
reset(); { const r = await h(new Request("https://f", { method: "GET", headers: { origin: APP } })); check("GET: 405", r.status === 405); }
reset(); { const r = await post({ ...good, website: "spam.com" }); check("robô (campo escondido): 400 e nada criado", r.status === 400 && calls.length === 0); }
for (const [n, b, msg] of [["nome curto", { ...good, name: "A" }, "Conte como"], ["e-mail ruim", { ...good, email: "ana@" }, "Confira o e-mail"],
  ["senha curta", { ...good, password: "1234567" }, "8 caracteres"], ["senha longa", { ...good, password: "x".repeat(73) }, "72"]] as const) {
  reset(); const r = await post(b); const j = await r.json();
  check(`validação: ${n}`, r.status === 400 && j.error.includes(msg) && calls.length === 0, JSON.stringify(j));
}

// sucesso
reset(); cfg.rpc.billing_start_trial = { data: { trial_ends_at: "2026-11-16T12:00:00Z" }, error: null };
{ const r = await post(good); const j = await r.json(); const st = fn("billing_start_trial"); const cu = fn("createUser"); const si = fn("signup_intent_register");
  check("sucesso: 200 com o fim do teste", r.status === 200 && j.ok === true && j.trial_ends_at === "2026-11-16T12:00:00Z");
  check("reserva primeiro, com e-mail em minúsculas e IP cifrado (nunca o IP puro)", calls[0][0] === "billing_start_trial" && st.p_email === "ana@exemplo.com"
    && typeof st.p_ip_hash === "string" && st.p_ip_hash.length === 32 && !st.p_ip_hash.includes("200.1"));
  check("login criado já confirmado, com a senha e o nome", cu.email === "ana@exemplo.com" && cu.password === "senha-forte" && cu.email_confirm === true && cu.user_metadata.full_name === "Ana Paula");
  check("funil do painel recebe só as UTMs válidas", si.p_email === "ana@exemplo.com" && si.p_utm.utm_source === "instagram" && !("lixo" in si.p_utm)); }
reset(); cfg.rpc.billing_start_trial = { data: { trial_ends_at: "x" }, error: null }; cfg.rpc.signup_intent_register = { data: null, error: { message: "falhou" } };
{ const r = await post(good); check("falha no funil não impede o cadastro", r.status === 200); }
{ reset(); const r1 = await post(good, APP, "1.1.1.1"); const a = fn("billing_start_trial").p_ip_hash;
  reset(); await post(good, APP, "1.1.1.1"); const b = fn("billing_start_trial").p_ip_hash;
  reset(); await post(good, APP, "2.2.2.2"); const c = fn("billing_start_trial").p_ip_hash;
  check("mesmo IP, mesma marca; IP diferente, marca diferente (limite por aparelho)", r1.status === 200 && a === b && a !== c); }

// recusas do banco
reset(); cfg.rpc.billing_start_trial = { data: null, error: { code: "23505", message: "Este e-mail já tem conta na Sócia. Entre com a sua senha." } };
{ const r = await post(good); const j = await r.json(); check("e-mail que já tem conta: 409 com o texto do banco e sem criar login", r.status === 409 && j.code === "23505" && j.error.startsWith("Este e-mail") && !fn("createUser")); }
reset(); cfg.rpc.billing_start_trial = { data: null, error: { code: "54000", message: "Muitos cadastros seguidos deste aparelho. Tente de novo mais tarde." } };
{ const r = await post(good); check("muitos cadastros do mesmo aparelho: 429", r.status === 429 && !fn("createUser")); }
reset(); cfg.rpc.billing_start_trial = { data: null, error: { code: "XX000", message: "interno" } };
{ const r = await post(good); const j = await r.json(); check("erro inesperado do banco: 500 sem mostrar o detalhe", r.status === 500 && !j.error.includes("interno")); }

// falha ao criar o login: desfaz a reserva
reset(); cfg.rpc.billing_start_trial = { data: { trial_ends_at: "x" }, error: null }; cfg.createUser = { data: null, error: { status: 422, message: "already registered" } };
{ const r = await post(good); check("login já existia: 409 e reserva desfeita", r.status === 409 && fn("billing_trial_release")?.p_email === "ana@exemplo.com"); }
reset(); cfg.rpc.billing_start_trial = { data: { trial_ends_at: "x" }, error: null }; cfg.createUser = { data: null, error: { status: 500, message: "boom" } };
{ const r = await post(good); check("erro ao criar login: 500 e reserva desfeita", r.status === 500 && !!fn("billing_trial_release")); }

check("cleanUtm e validate exportados", typeof (mod as any).cleanUtm === "function" && (mod as any).validate({ name: "Ana", email: "a@b.co", password: "12345678" }) === null);
console.info(`RESULTADO trial-signup: PASS=${pass} FAIL=${fail}`);
if (fail) Deno.exit(1);
