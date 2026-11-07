import { calls, cfg } from "./stub.ts";
for (const [k, v] of Object.entries({ MP_ACCESS_TOKEN: "APP_USR-x", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "s", SUPABASE_ANON_KEY: "a" })) Deno.env.set(k, v);
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
const routes: Record<string, [number, any]> = {}; const mpCalls: [string, string, any][] = [];
globalThis.fetch = (async (u: string, init: any = {}) => {
  const url = new URL(u); const key = `${init.method ?? "GET"} ${url.pathname}`; mpCalls.push([init.method ?? "GET", url.pathname, init.body ? JSON.parse(init.body) : null]);
  const r = routes[key];
  if (r?.[0] === -1) throw new Error("rede");
  return r ? new Response(JSON.stringify(r[1]), { status: r[0] }) : new Response("{}", { status: 404 });
}) as any;
console.log = () => {};
const account = await import("./account.ts"); const h = handler;
const admin = await import("./admin.ts");
const mpSync = await import("./sync.ts");
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = "") => { c ? pass++ : fail++; console.info((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); };
const reset = () => { calls.length = 0; mpCalls.length = 0; cfg.user = {}; cfg.service = {}; for (const k in routes) delete routes[k]; };
const post = (body: any, headers: Record<string, string> = { authorization: "Bearer jwt", origin: "https://hive-beauty.vercel.app" }) =>
  h(new Request("https://f/account-billing", { method: "POST", headers, body: JSON.stringify(body) }));
const CO = "11111111-2222-3333-4444-555555555555";

// --- entrada -----------------------------------------------------------------------------------
for (const o of ["https://hive-beauty.vercel.app", "https://socia-beauty.vercel.app", "https://socia-beauty-git-x-hive-beauty.vercel.app"]) {
  reset(); const r = await h(new Request("https://f", { method: "OPTIONS", headers: { origin: o } }));
  check(`CORS: ${o} aceito`, r.headers.get("access-control-allow-origin") === o);
}
reset(); { const r = await h(new Request("https://f", { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
  check("CORS: outro site não é ecoado", r.headers.get("access-control-allow-origin") === "https://hive-beauty.vercel.app"); }
reset(); { const r = await post({ action: "cancel", company_id: CO }, {}); check("sem sessão: 401 e nada acontece", r.status === 401 && calls.length === 0 && mpCalls.length === 0); }
reset(); { const r = await post({ action: "cancel", company_id: "abc" }); check("conta inválida: 400", r.status === 400 && calls.length === 0); }
reset(); { const r = await post({ action: "reconcile" }); check("ação de admin não existe aqui: 400", r.status === 400 && mpCalls.length === 0 && calls.length === 0); }
reset(); { const r = await h(new Request("https://f", { method: "GET" })); check("GET: 405", r.status === 405); }

// --- quem pode -----------------------------------------------------------------------------------
reset(); cfg.user.owner_cancel_prepare = { data: null, error: { code: "42501", message: "Só a dona da conta pode ver e mudar a assinatura." } };
{ const r = await post({ action: "cancel", company_id: CO }); const b = await r.json();
  check("não é a dona: 403, mensagem do banco e o Mercado Pago NÃO é chamado", r.status === 403 && mpCalls.length === 0 && b.error.startsWith("Só a dona")); }
reset(); cfg.user.owner_cancel_prepare = { data: null, error: { code: "55P03", message: "Já estamos cancelando. Aguarde um instante." } };
{ const r = await post({ action: "cancel", company_id: CO }); check("pedido em andamento: 409 sem chamar o Mercado Pago", r.status === 409 && mpCalls.length === 0); }
reset(); cfg.user.owner_cancel_prepare = { data: null, error: { code: "22023", message: "A assinatura já está cancelada." } };
{ const r = await post({ action: "cancel", company_id: CO }); check("já cancelada ou cortesia: 400", r.status === 400 && mpCalls.length === 0); }

// --- cancelamento ---------------------------------------------------------------------------------
reset(); cfg.user.owner_cancel_prepare = { data: { request_id: "r-1", preapproval_id: "PRE1" }, error: null };
cfg.user.owner_cancel_finish = { data: { ok: true, access: { status: "ending", allowed: true, until: "2026-12-04T10:00:00Z" } }, error: null };
routes["PUT /preapproval/PRE1"] = [200, { status: "cancelled" }];
routes["GET /preapproval/PRE1"] = [200, { status: "cancelled", payer_email: "Ana@X.com", last_modified: "2026-11-08T10:00:00Z" }];
{ const r = await post({ action: "cancel", company_id: CO, reason: "Está caro" }); const b = await r.json();
  const prep = calls.find((c) => c[1] === "owner_cancel_prepare"); const sync = calls.find((c) => c[1] === "billing_sync"); const fin = calls.find((c) => c[1] === "owner_cancel_finish");
  check("cancelamento: o banco escolhe a assinatura pela sessão (a empresa e o motivo vão juntos)", prep?.[0] === "user" && prep?.[2].p_company_id === CO && prep?.[2].p_reason === "Está caro");
  check("cancelamento: pede ao Mercado Pago status cancelled na assinatura que o banco devolveu", mpCalls.some((m) => m[0] === "PUT" && m[1] === "/preapproval/PRE1" && m[2]?.status === "cancelled"));
  check("cancelamento: sincroniza com a service role e origem owner", sync?.[0] === "service" && sync?.[2].p.status === "canceled" && sync?.[2].p.source === "owner" && sync?.[2].p.email === "ana@x.com");
  check("cancelamento: conclui com a sessão como ok e devolve o acesso (até o fim do mês pago)", r.status === 200 && fin?.[0] === "user" && fin?.[2].p_ok === true && fin?.[2].p_request_id === "r-1" && b.access?.status === "ending"); }
reset(); cfg.user.owner_cancel_prepare = { data: { request_id: "r-2", preapproval_id: "PRE1" }, error: null };
routes["PUT /preapproval/PRE1"] = [500, { message: "erro" }]; routes["GET /preapproval/PRE1"] = [200, { status: "authorized", payer_email: "ana@x.com" }];
{ const r = await post({ action: "cancel", company_id: CO }); const fin = calls.find((c) => c[1] === "owner_cancel_finish");
  check("Mercado Pago recusou: 502, pedido registrado como erro, banco com a situação real", r.status === 502 && fin?.[2].p_ok === false && fin?.[2].p_detail.startsWith("MP 500")
    && calls.find((c) => c[1] === "billing_sync")?.[2].p.status === "active"); }
reset(); cfg.user.owner_cancel_prepare = { data: { request_id: "r-3", preapproval_id: "PRE1" }, error: null };
routes["PUT /preapproval/PRE1"] = [400, { message: "already cancelled" }]; routes["GET /preapproval/PRE1"] = [200, { status: "cancelled", payer_email: "ana@x.com" }];
{ const r = await post({ action: "cancel", company_id: CO }); check("já estava cancelada no Mercado Pago: confirma e conclui (200)", r.status === 200); }
reset(); cfg.user.owner_cancel_prepare = { data: { request_id: "r-4", preapproval_id: "PRE1" }, error: null };
routes["PUT /preapproval/PRE1"] = [-1, null]; routes["GET /preapproval/PRE1"] = [-1, null];
{ const r = await post({ action: "cancel", company_id: CO }); const fin = calls.find((c) => c[1] === "owner_cancel_finish");
  check("sem rede: 502 e o pedido fica registrado como erro", r.status === 502 && fin?.[2].p_ok === false); }
reset(); cfg.user.owner_cancel_prepare = { data: { request_id: "r-5", preapproval_id: "PRE1" }, error: null };
{ const long = "x".repeat(900); await post({ action: "cancel", company_id: CO, reason: long });
  check("motivo longo é cortado em 500 caracteres antes de ir ao banco", calls.find((c) => c[1] === "owner_cancel_prepare")?.[2].p_reason.length === 500); }

// --- paridade ------------------------------------------------------------------------------------
const cases = [{ status: "authorized" }, { status: "authorized", date_created: new Date().toISOString(), auto_recurring: { free_trial: { frequency: 7 } } },
  { status: "paused" }, { status: "cancelled" }, { status: "pending" }, {}];
check("mapStatus igual ao da admin-billing e da mp-sync", cases.every((c) => account.mapStatus(c) === admin.mapStatus(c) && account.mapStatus(c) === mpSync.mapStatus(c)));

console.info(`RESULTADO account-billing: PASS=${pass} FAIL=${fail}`);
if (fail) Deno.exit(1);
