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
const reset = () => { calls.length = 0; Object.assign(cfg, { rpcError: null, createErr: null, resetErr: null }); for (const k in mpRoutes) delete mpRoutes[k]; };
const recent = new Date().toISOString(), old = "2026-01-01T00:00:00Z";

reset(); { const r = await handler(new Request("https://f/mp-webhook", { method: "POST", body: "{}" })); check("sem data.id -> 200, nada gravado", r.status === 200 && calls.length === 0); }
reset(); { const [s] = await send("subscription_preapproval", "PRE1", false); check("assinatura HMAC errada -> 401, nada gravado", s === 401 && calls.length === 0); }
reset(); mpRoutes["/preapproval/PRE1"] = [200, { status: "authorized", payer_email: " Nova@Gmail.com ", date_created: recent, auto_recurring: { free_trial: { frequency: 7 } }, next_payment_date: "2026-10-29T00:00:00Z" }];
{ const [s] = await send("subscription_preapproval", "PRE1");
  const up = calls.find(c=>c[1]==="billing_upsert"); const rs = calls.find(c=>c[0]==="reset");
  check("nova assinatura em teste grátis -> trialing gravado com e-mail normalizado", s===200 && up?.[2].p_status==="trialing" && up?.[2].p_email==="nova@gmail.com");
  check("conta nova: createUser confirmado + e-mail com redirectTo do app", !!calls.find(c=>c[0]==="createUser"&&c[1].email_confirm) && rs?.[2]?.redirectTo==="https://hive-beauty.vercel.app/redefinir-senha");
  check("log mascara o e-mail", logs.at(-1)!.includes("no***@gmail.com") && !logs.at(-1)!.includes("nova@gmail.com")); }
reset(); cfg.createErr = { status: 422, message: "already registered" }; mpRoutes["/preapproval/PRE2"] = [200, { status: "authorized", payer_email: "tai@gmail.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE2"); check("conta já existente -> active, sem e-mail de senha, 200", s===200 && calls.find(c=>c[1]==="billing_upsert")?.[2].p_status==="active" && !calls.find(c=>c[0]==="reset")); }
reset(); cfg.createErr = { status: 500, message: "boom" }; mpRoutes["/preapproval/PRE3"] = [200, { status: "authorized", payer_email: "a@b.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE3"); check("falha ao criar conta -> 500 (o MP reenvia)", s===500); }
reset(); mpRoutes["/preapproval/PRE4"] = [503, {}]; { const [s] = await send("subscription_preapproval", "PRE4"); check("Mercado Pago fora (503) -> 500 (o MP reenvia)", s===500 && calls.length===0); }
reset(); mpRoutes["/preapproval/PRE5"] = [-1, {}]; { const [s] = await send("subscription_preapproval", "PRE5"); check("erro de rede -> 500", s===500); }
reset(); { const [s] = await send("subscription_preapproval", "123456"); check("id inexistente (simulação do painel, 404) -> 200, sem loop de reenvio", s===200 && calls.length===0); }
reset(); cfg.rpcError = "x"; mpRoutes["/preapproval/PRE6"] = [200, { status: "authorized", payer_email: "a@b.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE6"); check("erro ao gravar -> 500 e NÃO cria conta", s===500 && !calls.find(c=>c[0]==="createUser")); }
reset(); mpRoutes["/authorized_payments/PAY1"] = [200, { preapproval_id: "PRE7" }]; mpRoutes["/preapproval/PRE7"] = [200, { status: "paused", payer_email: "a@b.com" }];
{ const [s] = await send("subscription_authorized_payment", "PAY1"); check("aviso de pagamento -> busca a assinatura; pausada = past_due, sem criar conta", s===200 && calls.find(c=>c[1]==="billing_upsert")?.[2].p_preapproval_id==="PRE7" && calls.find(c=>c[1]==="billing_upsert")?.[2].p_status==="past_due" && !calls.find(c=>c[0]==="createUser")); }
reset(); mpRoutes["/preapproval/PRE8"] = [200, { status: "cancelled", payer_email: "a@b.com" }];
{ const [s] = await send("subscription_preapproval", "PRE8"); check("cancelada -> canceled, sem criar conta", s===200 && calls.find(c=>c[1]==="billing_upsert")?.[2].p_status==="canceled" && !calls.find(c=>c[0]==="createUser")); }
reset(); mpRoutes["/preapproval/PRE9"] = [200, { status: "authorized", payer_email: "" }];
{ const [s] = await send("subscription_preapproval", "PRE9"); check("sem payer_email -> 200 'sem e-mail', registrado no log", s===200 && calls.length===0 && logs.at(-1)!.includes("sem e-mail")); }
reset(); cfg.resetErr = { message: "rate limit" }; mpRoutes["/preapproval/PRE10"] = [200, { status: "authorized", payer_email: "z@b.com", date_created: old }];
{ const [s] = await send("subscription_preapproval", "PRE10"); check("e-mail de senha falhou -> 200 (não repete) e fica no log", s===200 && logs.at(-1)!.includes("NÃO enviado")); }
reset(); { const [s] = await send("payment", "999"); check("outro tipo de aviso -> ignorado", s===200 && calls.length===0); }
console.info(`RESULTADO mp-webhook: PASS=${pass} FAIL=${fail}`);
