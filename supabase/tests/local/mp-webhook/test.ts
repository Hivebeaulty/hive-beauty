import { calls, cfg } from "./stub.ts";
Deno.env.set("MP_ACCESS_TOKEN","tok"); Deno.env.set("MP_WEBHOOK_SECRET","segredo"); Deno.env.set("SUPABASE_URL","x"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","y");
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
const mpRoutes: Record<string, [number, any]> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string) => { const p = new URL(u).pathname; const r = mpRoutes[p]; if (r?.[0] === -1) throw new Error("rede"); return r ? new Response(JSON.stringify(r[1]), { status: r[0] }) : new Response("{}", { status: 404 }); }) as any;
console.log = ((orig) => (...a: any[]) => { if (String(a[0]).includes('"fn":"mp-webhook"')) logs.push(a[0]); else orig(...a); })(console.log);
const logs: string[] = [];
await import("./index.ts");
async function hmac(msg: string) { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("segredo"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))].map(b=>b.toString(16).padStart(2,"0")).join(""); }
async function send(type: string, id: string, signed = true) {
  const ts = "1700000000", rid = "req-1";
  const v1 = signed ? await hmac(`id:${id.toLowerCase()};request-id:${rid};ts:${ts};`) : "errado";
  const req = new Request(`https://f/mp-webhook?data.id=${id}&type=${type}`, { method: "POST", headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": rid }, body: JSON.stringify({ type, data: { id } }) });
  const r = await handler(req); return [r.status, await r.text()];
}
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.info((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(calls) + " " + logs.at(-1))); };
const reset = () => { calls.length = 0; Object.assign(cfg, { rpcError: null, rpcErrorFn: null, createErr: null, resetErr: null }); for (const k in mpRoutes) delete mpRoutes[k]; };
const recent = new Date().toISOString(), old = "2026-01-01T00:00:00Z";

reset(); { const r = await handler(new Request("https://f/mp-webhook", { method: "POST", body: "{}" })); check("sem data.id -> 200, nada gravado", r.status === 200 && calls.length === 0); }
reset(); { const [s] = await send("subscription_preapproval", "PRE1", false); check("assinatura HMAC errada -> 401, nada gravado", s === 401 && calls.length === 0); }
reset(); mpRoutes["/preapproval/PRE1"] = [200, { status: "authorized", payer_email: " Nova@Gmail.com ", date_created: recent, auto_recurring: { free_trial: { frequency: 7 } }, next_payment_date: "2026-10-29T00:00:00Z" }];
{ const [s] = await send("subscription_preapproval", "PRE1");
  const up = calls.find(c=>c[1]==="billing_sync"); const rs = calls.find(c=>c[0]==="reset");
  check("nova assinatura em teste grátis -> trialing gravado com e-mail normalizado", s===200 && up?.[2].p.status==="trialing" && up?.[2].p.email==="nova@gmail.com");
  check("conta nova: createUser confirmado + e-mail com redirectTo do app", !!calls.find(c=>c[0]==="createUser"&&c[1].email_confirm) && rs?.[2]?.redirectTo==="https://hive-beauty.vercel.app/redefinir-senha");
  check("log mascara o e-mail", logs.at(-1)!.includes("no***@gmail.com") && !logs.at(-1)!.includes("nova@gmail.com")); }
reset(); cfg.createErr = { status: 422, message: "already registered" }; mpRoutes["/preapproval/PRE2"] = [200, { status: "authorized", payer_email: "tai@gmail.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE2"); check("conta já existente -> active, sem e-mail de senha, 200", s===200 && calls.find(c=>c[1]==="billing_sync")?.[2].p.status==="active" && !calls.find(c=>c[0]==="reset")); }
reset(); cfg.createErr = { status: 500, message: "boom" }; mpRoutes["/preapproval/PRE3"] = [200, { status: "authorized", payer_email: "a@b.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE3"); check("falha ao criar conta -> 500 (o MP reenvia)", s===500); }
reset(); mpRoutes["/preapproval/PRE4"] = [503, {}]; { const [s] = await send("subscription_preapproval", "PRE4"); check("Mercado Pago fora (503) -> 500 (o MP reenvia)", s===500 && calls.length===0); }
reset(); mpRoutes["/preapproval/PRE5"] = [-1, {}]; { const [s] = await send("subscription_preapproval", "PRE5"); check("erro de rede -> 500", s===500); }
reset(); { const [s] = await send("subscription_preapproval", "123456"); check("id inexistente (simulação do painel, 404) -> 200, sem loop de reenvio", s===200 && calls.length===0); }
reset(); cfg.rpcError = "x"; mpRoutes["/preapproval/PRE6"] = [200, { status: "authorized", payer_email: "a@b.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE6"); check("erro ao gravar -> 500 e NÃO cria conta", s===500 && !calls.find(c=>c[0]==="createUser")); }
reset(); mpRoutes["/authorized_payments/PAY1"] = [200, { preapproval_id: "PRE7" }]; mpRoutes["/preapproval/PRE7"] = [200, { status: "paused", payer_email: "a@b.com" }];
{ const [s] = await send("subscription_authorized_payment", "PAY1"); check("aviso de pagamento -> busca a assinatura; pausada = past_due, sem criar conta", s===200 && calls.find(c=>c[1]==="billing_sync")?.[2].p.preapproval_id==="PRE7" && calls.find(c=>c[1]==="billing_sync")?.[2].p.status==="past_due" && !calls.find(c=>c[0]==="createUser")); }
reset(); mpRoutes["/preapproval/PRE8"] = [200, { status: "cancelled", payer_email: "a@b.com" }];
{ const [s] = await send("subscription_preapproval", "PRE8"); check("cancelada -> canceled, sem criar conta", s===200 && calls.find(c=>c[1]==="billing_sync")?.[2].p.status==="canceled" && !calls.find(c=>c[0]==="createUser")); }
reset(); mpRoutes["/preapproval/PRE9"] = [200, { status: "authorized", payer_email: "" }];
{ const [s] = await send("subscription_preapproval", "PRE9"); check("sem payer_email -> 200 'sem e-mail', registrado no log", s===200 && calls.length===0 && logs.at(-1)!.includes("sem e-mail")); }
reset(); cfg.resetErr = { message: "rate limit" }; mpRoutes["/preapproval/PRE10"] = [200, { status: "authorized", payer_email: "z@b.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE10"); check("e-mail de senha falhou -> 200 (não repete) e fica no log", s===200 && logs.at(-1)!.includes("NÃO enviado")); }
reset(); { const [s] = await send("payment", "999"); check("outro tipo de aviso -> ignorado", s===200 && calls.length===0); }
// --- Fase 3: cobranças -------------------------------------------------------------------
const PRE_OK = { status: "authorized", payer_email: "ana@x.com", payer_id: 77, date_created: old, last_modified: "2026-10-27T12:00:00Z",
  next_payment_date: "2026-11-27T12:00:00Z", auto_recurring: { transaction_amount: 59.9, currency_id: "BRL" } };
reset(); mpRoutes["/authorized_payments/AP1"] = [200, { id: 101, preapproval_id: "PREA", status: "processed", transaction_amount: 59.9,
  currency_id: "BRL", last_modified: "2026-10-27T12:00:00Z", debit_date: "2026-10-27T11:00:00Z", payment: { id: 555, status: "approved" } }];
mpRoutes["/v1/payments/555"] = [200, { status: "approved", status_detail: "accredited", transaction_amount: 59.9, transaction_amount_refunded: 0,
  fee_details: [{ amount: 2.39, fee_payer: "collector" }, { amount: 0.6, fee_payer: "collector" }, { amount: 5, fee_payer: "payer" }],
  transaction_details: { net_received_amount: 56.91 }, date_approved: "2026-10-27T12:01:00Z", date_last_updated: "2026-10-27T12:01:30Z",
  card: { last_four_digits: "4242" }, payer: { identification: { number: "12345678900" } } }];
mpRoutes["/preapproval/PREA"] = [200, PRE_OK];
{ const [s] = await send("subscription_authorized_payment", "AP1");
  const rec = calls.find(c=>c[1]==="billing_record_payment")?.[2].p; const iRec = calls.findIndex(c=>c[1]==="billing_record_payment"); const iSync = calls.findIndex(c=>c[1]==="billing_sync");
  check("cobrança aprovada: grava bruto, taxas da Áurea (sem a do cliente) e líquido", s===200 && rec?.status==="approved" && rec?.amount===59.9 && rec?.fee_amount===2.99 && rec?.net_amount===56.91 && rec?.paid_at==="2026-10-27T12:01:00Z");
  check("cobrança: ids e e-mail; data mais nova entre cobrança e pagamento", rec?.authorized_payment_id==="101" && rec?.payment_id==="555" && rec?.email==="ana@x.com" && rec?.last_modified==="2026-10-27T12:01:30.000Z");
  check("cobrança: nada de cartão ou documento vai para o banco", !JSON.stringify(rec).includes("4242") && !JSON.stringify(rec).includes("12345678900"));
  check("cobrança gravada antes da situação; situação com valor, moeda e last_modified", iRec >= 0 && iRec < iSync && calls[iSync][2].p.amount===59.9 && calls[iSync][2].p.last_modified==="2026-10-27T12:00:00Z" && calls[iSync][2].p.payer_id==="77"); }
reset(); mpRoutes["/authorized_payments/AP2"] = [200, { id: 102, preapproval_id: "PREA", status: "recycling", transaction_amount: 59.9, retry_attempt: 2, rejection_code: "cc_rejected_insufficient_amount" }];
mpRoutes["/preapproval/PREA"] = [200, { ...PRE_OK, status: "paused" }];
{ const [s] = await send("subscription_authorized_payment", "AP2"); const rec = calls.find(c=>c[1]==="billing_record_payment")?.[2].p;
  check("cobrança recusada sem pagamento gerado: 'rejected' com motivo e tentativa", s===200 && rec?.status==="rejected" && rec?.status_detail==="cc_rejected_insufficient_amount" && rec?.retry_attempt===2 && rec?.fee_amount===null); }
reset(); mpRoutes["/authorized_payments/AP3"] = [200, { id: 103, preapproval_id: "PREA", status: "processed", payment: { id: 999, status: "approved" } }];
mpRoutes["/v1/payments/999"] = [404, {}]; mpRoutes["/preapproval/PREA"] = [200, PRE_OK];
{ const [s] = await send("subscription_authorized_payment", "AP3"); const rec = calls.find(c=>c[1]==="billing_record_payment")?.[2].p;
  check("pagamento não encontrado (404): grava com os dados da cobrança", s===200 && rec?.status==="approved" && rec?.net_amount===null); }
reset(); mpRoutes["/authorized_payments/AP4"] = [200, { id: 104, preapproval_id: "PREA", status: "processed", payment: { id: 888 } }];
mpRoutes["/v1/payments/888"] = [503, {}];
{ const [s] = await send("subscription_authorized_payment", "AP4"); check("pagamento fora do ar: 500 (o Mercado Pago reenvia) e nada gravado", s===500 && calls.length===0); }
reset(); cfg.rpcError = "x"; cfg.rpcErrorFn = "billing_record_payment"; mpRoutes["/authorized_payments/AP1"] = [200, { id: 101, preapproval_id: "PREA", status: "processed" }]; mpRoutes["/preapproval/PREA"] = [200, PRE_OK];
{ const [s] = await send("subscription_authorized_payment", "AP1"); check("erro ao gravar cobrança: 500 e a situação não é gravada", s===500 && !calls.find(c=>c[1]==="billing_sync")); }
reset(); mpRoutes["/authorized_payments/AP5"] = [200, { id: 105, preapproval_id: "PREB", status: "processed", payment: { id: 1 } }];
mpRoutes["/v1/payments/1"] = [200, { status: "approved", transaction_amount: 59.9 }]; mpRoutes["/preapproval/PREB"] = [200, { status: "authorized", payer_email: "" }];
{ const [s] = await send("subscription_authorized_payment", "AP5");
  check("assinatura sem e-mail: a cobrança fica registrada mesmo assim", s===200 && calls.find(c=>c[1]==="billing_record_payment")?.[2].p.status==="approved" && !calls.find(c=>c[1]==="billing_sync")); }
reset(); mpRoutes["/authorized_payments/AP6"] = [200, { id: 106, preapproval_id: "PREA", status: "processed", payment: { id: 2 } }];
mpRoutes["/v1/payments/2"] = [200, { status: "refunded", transaction_amount: 59.9, transaction_amount_refunded: 59.9 }]; mpRoutes["/preapproval/PREA"] = [200, PRE_OK];
{ await send("subscription_authorized_payment", "AP6"); const rec = calls.find(c=>c[1]==="billing_record_payment")?.[2].p;
  check("reembolso: situação e valor reembolsado vêm do pagamento", rec?.status==="refunded" && rec?.refunded_amount===59.9); }
console.info(`RESULTADO mp-webhook: PASS=${pass} FAIL=${fail}`);
