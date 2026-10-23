import { calls, cfg } from "./stub.ts";
for (const [k, v] of Object.entries({ MP_ACCESS_TOKEN: "APP_USR-x", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "s", SUPABASE_ANON_KEY: "a" })) Deno.env.set(k, v);
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
const routes: Record<string, [number, any]> = {}; const mpCalls: [string, string, any][] = [];
globalThis.fetch = (async (u: string, init: any = {}) => {
  const url = new URL(u); const key = `${init.method ?? "GET"} ${url.pathname}${url.search}`; mpCalls.push([init.method ?? "GET", url.pathname + url.search, init.body ? JSON.parse(init.body) : null]);
  const r = routes[key] ?? routes[`${init.method ?? "GET"} ${url.pathname}`];
  if (r?.[0] === -1) throw new Error("rede");
  return r ? new Response(JSON.stringify(r[1]), { status: r[0] }) : new Response("{}", { status: 404 });
}) as any;
console.log = () => {};
const admin = await import("./admin.ts"); const adminHandler = handler;
const hook = await import("./hook.ts");
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = "") => { c ? pass++ : fail++; console.info((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + extra)); };
const reset = () => { calls.length = 0; mpCalls.length = 0; cfg.user = {}; cfg.service = {}; for (const k in routes) delete routes[k]; };
const post = (body: any, headers: Record<string, string> = { authorization: "Bearer jwt", origin: "https://hive-beauty.vercel.app" }) =>
  adminHandler(new Request("https://f/admin-billing", { method: "POST", headers, body: JSON.stringify(body) }));
const CO = "11111111-2222-3333-4444-555555555555";

// --- entrada -----------------------------------------------------------------------------------
reset(); { const r = await adminHandler(new Request("https://f", { method: "OPTIONS", headers: { origin: "https://hive-beauty-git-x-hive-beauty.vercel.app" } }));
  check("CORS: preview da Vercel do projeto é aceito", r.headers.get("access-control-allow-origin") === "https://hive-beauty-git-x-hive-beauty.vercel.app"); }
reset(); { const r = await adminHandler(new Request("https://f", { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
  check("CORS: outro site não é ecoado", r.headers.get("access-control-allow-origin") === "https://hive-beauty.vercel.app"); }
reset(); { const r = await post({ action: "cancel", company_id: CO, reason: "x" }, {}); check("sem sessão: 401 e nada acontece", r.status === 401 && calls.length === 0 && mpCalls.length === 0); }
reset(); { const r = await post({ action: "cancel", company_id: "abc", reason: "motivo" }); check("conta inválida: 400", r.status === 400 && calls.length === 0); }
reset(); { const r = await post({ action: "apagar-tudo" }); check("ação desconhecida: 400", r.status === 400 && mpCalls.length === 0); }

// --- cancelamento -------------------------------------------------------------------------------
reset(); cfg.user.admin_cancel_prepare = { data: null, error: { code: "42501", message: "Acesso restrito." } };
{ const r = await post({ action: "cancel", company_id: CO, reason: "motivo" }); check("não é superadmin: 403 e o Mercado Pago NÃO é chamado", r.status === 403 && mpCalls.length === 0); }
reset(); cfg.user.admin_cancel_prepare = { data: null, error: { code: "AUA01", message: "MFA" } };
{ const r = await post({ action: "cancel", company_id: CO, reason: "motivo" }); check("sem MFA: 403 e o Mercado Pago NÃO é chamado", r.status === 403 && mpCalls.length === 0); }
reset(); cfg.user.admin_cancel_prepare = { data: { preapproval_id: "PRE1", correlation_id: "c-1" }, error: null };
routes["PUT /preapproval/PRE1"] = [200, { status: "cancelled" }]; routes["GET /preapproval/PRE1"] = [200, { status: "cancelled", payer_email: "Ana@X.com", last_modified: "2026-11-02T10:00:00Z" }];
{ const r = await post({ action: "cancel", company_id: CO, reason: "Pedido da dona" });
  const sync = calls.find((c) => c[1] === "billing_sync"); const fin = calls.find((c) => c[1] === "admin_cancel_finish");
  check("cancelamento: pede ao Mercado Pago status cancelled", mpCalls.some((m) => m[0] === "PUT" && m[1] === "/preapproval/PRE1" && m[2]?.status === "cancelled"));
  check("cancelamento: autorização com a sessão, gravação com a service role", calls[0][0] === "user" && calls[0][1] === "admin_cancel_prepare" && sync?.[0] === "service");
  check("cancelamento: só marca cancelada depois de consultar o Mercado Pago", sync?.[2].p.status === "canceled" && sync?.[2].p.source === "admin" && sync?.[2].p.email === "ana@x.com");
  check("cancelamento: conclusão auditada como ok, 200", r.status === 200 && fin?.[0] === "user" && fin?.[2].p_ok === true && fin?.[2].p_correlation_id === "c-1"); }
reset(); cfg.user.admin_cancel_prepare = { data: { preapproval_id: "PRE1", correlation_id: "c-2" }, error: null };
routes["PUT /preapproval/PRE1"] = [400, { message: "erro" }]; routes["GET /preapproval/PRE1"] = [200, { status: "authorized", payer_email: "ana@x.com" }];
{ const r = await post({ action: "cancel", company_id: CO, reason: "Pedido da dona" }); const fin = calls.find((c) => c[1] === "admin_cancel_finish");
  check("Mercado Pago recusou: 502, auditado como erro, banco fica com a situação real (ativa)", r.status === 502 && fin?.[2].p_ok === false
    && calls.find((c) => c[1] === "billing_sync")?.[2].p.status === "active"); }
reset(); cfg.user.admin_cancel_prepare = { data: { preapproval_id: "PRE1", correlation_id: "c-3" }, error: null };
routes["PUT /preapproval/PRE1"] = [400, { message: "already cancelled" }]; routes["GET /preapproval/PRE1"] = [200, { status: "cancelled", payer_email: "ana@x.com" }];
{ const r = await post({ action: "cancel", company_id: CO, reason: "Pedido da dona" }); check("já estava cancelada no Mercado Pago: confirma e conclui (200)", r.status === 200); }

// --- conciliação ---------------------------------------------------------------------------------
reset(); cfg.user.admin_reconcile_targets = { data: ["PRE1"], error: null };
routes["GET /preapproval/PRE1"] = [200, { status: "authorized", payer_email: "ana@x.com", last_modified: "2026-11-01T10:00:00Z" }];
routes["GET /authorized_payments/search"] = [200, { results: [
  { id: 1, preapproval_id: "PRE1", status: "processed", payment: { id: 9 } },
  { id: 2, preapproval_id: "PRE1", status: "scheduled", transaction_amount: 59.9 }] }];
routes["GET /v1/payments/9"] = [200, { status: "refunded", transaction_amount: 59.9, transaction_amount_refunded: 59.9, date_approved: "2026-11-01T10:01:00Z" }];
{ const r = await post({ action: "reconcile" }); const b = await r.json(); const recs = calls.filter((c) => c[1] === "billing_record_payment");
  check("conciliação: situação via Mercado Pago (source reconcile)", calls.find((c) => c[1] === "billing_sync")?.[2].p.source === "reconcile");
  check("conciliação: busca as cobranças da assinatura", mpCalls.some((m) => m[1].startsWith("/authorized_payments/search?preapproval_id=PRE1")));
  check("conciliação: pega reembolso que não gerou aviso", recs.length === 2 && recs[0][2].p.status === "refunded" && recs[0][2].p.refunded_amount === 59.9 && recs[0][0] === "service");
  check("conciliação: resultado registrado (sem e-mails) e 200", r.status === 200 && b.checked === 1 && b.payments === 2 && b.errors === 0
    && calls.find((c) => c[1] === "admin_log_reconcile")?.[0] === "user" && !JSON.stringify(calls.find((c) => c[1] === "admin_log_reconcile")?.[2]).includes("ana@")); }
reset(); cfg.user.admin_reconcile_targets = { data: ["PRE1", "PRE2"], error: null };
routes["GET /preapproval/PRE1"] = [503, {}]; routes["GET /preapproval/PRE2"] = [200, { status: "cancelled", payer_email: "b@x.com" }];
routes["GET /authorized_payments/search"] = [200, { results: [] }];
{ const r = await post({ action: "reconcile" }); const b = await r.json();
  check("conciliação com falha parcial: segue nas outras, 207 e erro contado", r.status === 207 && b.checked === 1 && b.errors === 1 && b.problems[0].startsWith("PRE1")); }
reset(); cfg.user.admin_reconcile_targets = { data: null, error: { code: "AUA01", message: "MFA" } };
{ const r = await post({ action: "reconcile" }); check("conciliação sem MFA: 403 e Mercado Pago não chamado", r.status === 403 && mpCalls.length === 0); }

// --- mesmas regras que o webhook ------------------------------------------------------------------
const samples: [any, any][] = [
  [{ id: 1, preapproval_id: "P", status: "processed", payment: { id: 5, status: "approved" }, last_modified: "2026-11-01T00:00:00Z" },
   { status: "approved", transaction_amount: 59.9, fee_details: [{ amount: 2, fee_payer: "collector" }, { amount: 1, fee_payer: "payer" }], transaction_details: { net_received_amount: 57.9 }, date_last_updated: "2026-11-02T00:00:00Z" }],
  [{ id: 2, preapproval_id: "P", status: "recycling", rejection_code: "x", retry_attempt: 3 }, null],
  [{ id: 3, preapproval_id: "P", status: "scheduled", transaction_amount: 59.9 }, null],
];
check("conversão de cobrança idêntica à do mp-webhook", samples.every(([ap, p]) => JSON.stringify(admin.paymentRecord(ap, p, "a@b.c")) === JSON.stringify(hook.paymentRecord(ap, p, "a@b.c"))));
console.info(`RESULTADO admin-billing: PASS=${pass} FAIL=${fail}`);
