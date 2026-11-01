import { calls, st } from "./stub.ts";
Deno.env.set("SUPABASE_URL", "x"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "y");
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
const m = await import("./index.ts");
let pass = 0, fail = 0; const check = (n: string, c: boolean, x = "") => { c ? pass++ : fail++; console.info((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + x)); };
const SITE = "https://socia-beauty.lovable.app";
const post = (body: unknown, origin = SITE) => handler(new Request("https://f/signup-intent", { method: "POST", headers: { origin, "content-type": "text/plain" }, body: typeof body === "string" ? body : JSON.stringify(body) }));

calls.length = 0;
{ const r = await post({ email: "  Nova@Cliente.com ", utm: { utm_source: "instagram", utm_campaign: "lancamento", gclid: "x", email: "y" } }); const j = await r.json();
  const a = calls[0]?.[1];
  check("e-mail válido: registrado (200)", r.status === 200 && j.ok === true);
  check("e-mail normalizado e só UTM conhecidas", a.p_email === "nova@cliente.com" && a.p_utm.utm_source === "instagram" && a.p_utm.utm_campaign === "lancamento" && !("gclid" in a.p_utm) && !("email" in a.p_utm), JSON.stringify(a));
  check("CORS só para o site", r.headers.get("access-control-allow-origin") === SITE); }
calls.length = 0;
{ const r = await post({ email: "a@x.com" }, "https://evil.com"); check("outro site: 403, nada gravado", r.status === 403 && calls.length === 0); }
calls.length = 0;
{ const r = await post({ email: "a@x.com" }, "https://aurea-hivebeauty.lovable.app"); check("endereço antigo da landing (liberado no Lovable): 403", r.status === 403 && calls.length === 0); }
{ const r = await post({ email: "a@x.com" }, "https://hive-beauty.vercel.app"); check("app também pode chamar", r.status === 200); }
calls.length = 0;
{ const r = await post({ email: "sem-arroba" }); const j = await r.json(); check("e-mail inválido: 400 com mensagem clara, nada gravado", r.status === 400 && j.error === "Confira o e-mail digitado." && calls.length === 0); }
{ const r = await post("{não é json"); check("corpo inválido: 400", r.status === 400); }
{ const r = await post("x".repeat(3000)); check("corpo grande: 400", r.status === 400); }
st.error = { code: "P0001", message: "Muitos" };
{ const r = await post({ email: "a@x.com" }); const j = await r.json(); check("limite do banco: 429 com mensagem", r.status === 429 && j.error.startsWith("Muitos cadastros")); }
st.error = { code: "XX000", message: "falha" };
{ const r = await post({ email: "a@x.com" }); check("erro do banco: 500 sem detalhes internos", r.status === 500 && !(await r.text()).includes("falha")); }
st.error = null;
{ const r = await handler(new Request("https://f/x", { method: "OPTIONS", headers: { origin: SITE } })); check("preflight", r.status === 204); }
check("cleanUtm corta texto longo", m.cleanUtm({ utm_source: "a".repeat(300) }).utm_source.length === 100);
console.info(`RESULTADO signup-intent: PASS=${pass} FAIL=${fail}`);
