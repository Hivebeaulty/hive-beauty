import { calls, st } from "./stub.ts";
Deno.env.set("SUPABASE_URL", "x"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "y"); Deno.env.set("MP_ACCESS_TOKEN", "APP_USR-1");
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
const now = Date.now(); const iso = (d: number) => new Date(now - d * 86400000).toISOString();
const mpCalls: string[] = [];
(globalThis as any).fetch = async (url: string) => {
  const u = url.replace("https://api.mercadopago.com", ""); mpCalls.push(u);
  const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.startsWith("/preapproval/search")) return J({ paging: { total: 3 }, results: [
    { id: "NEW", status: "authorized", payer_email: "", last_modified: iso(0.01), date_created: iso(0.01) },
    { id: "OLD", status: "cancelled", last_modified: iso(60), date_created: iso(90) },
    { id: "SAME", status: "authorized", last_modified: iso(2), date_created: iso(3) } ] });
  if (u === "/preapproval/NEW") return J({ id: "NEW", status: "authorized", payer_email: "TaiinaDoCarmo@gmail.com", date_created: iso(0.01),
    last_modified: iso(0.01), next_payment_date: iso(-7), auto_recurring: { free_trial: { frequency: 7 }, transaction_amount: 1, currency_id: "BRL" } });
  if (u.startsWith("/authorized_payments/search")) return J({ results: [] });
  return J({ message: "not found" }, 404);
};
const m = await import("./index.ts");
let pass = 0, fail = 0; const check = (n: string, c: boolean, x = "") => { c ? pass++ : fail++; console.info((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + x)); };
const post = () => handler(new Request("https://f/mp-sync", { method: "POST", headers: { "x-cron-secret": "s".repeat(64) } }));

st.secretOk = false; { const r = await post(); check("sem segredo: 401, nada consultado", r.status === 401 && mpCalls.length === 0); }
st.secretOk = true; st.known = [{ id: "SAME", last_modified: iso(2) }];
{ const r = await post(); const j = await r.json();
  check("lista só a janela de 30 dias (a antiga fica de fora)", j.listed === 2, JSON.stringify(j));
  check("só processa o que é novo ou mudou", j.synced === 1 && !mpCalls.includes("/preapproval/SAME"), JSON.stringify(mpCalls));
  const sync = calls.find((c) => c[0] === "billing_sync")?.[1].p;
  check("grava pela consulta individual (e-mail em minúsculas, teste grátis)", sync?.email === "taiinadocarmo@gmail.com" && sync?.status === "trialing" && sync?.source === "reconcile" && sync?.amount === 1);
  check("cria a conta e envia o e-mail de senha", calls.some((c) => c[0] === "createUser" && c[1].email === "taiinadocarmo@gmail.com") && calls.some((c) => c[0] === "reset" && c[2].redirectTo === "https://hive-beauty.vercel.app/redefinir-senha"));
  check("marca como processada", calls.some((c) => c[0] === "mp_sync_mark" && c[1].p_id === "NEW"));
  check("consulta as cobranças da assinatura", mpCalls.some((u) => u.startsWith("/authorized_payments/search?preapproval_id=NEW"))); }
calls.length = 0; st.createErr = { status: 422, message: "already registered" };
{ await post(); check("conta já existente: não reenvia e-mail de senha (mantém a senha dela)", !calls.some((c) => c[0] === "reset")); }
check("mapStatus igual à mp-webhook", m.mapStatus({ status: "paused" }) === "past_due" && m.mapStatus({ status: "cancelled" }) === "canceled" && m.mapStatus({ status: "authorized", date_created: iso(10), auto_recurring: { free_trial: {} } }) === "active");
st.known = []; st.createErr = null; calls.length = 0;
(globalThis as any).fetch = async (url: string) => {
  const u = url.replace("https://api.mercadopago.com", ""); const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.startsWith("/preapproval/search")) return J({ paging: { total: 2 }, results: [
    { id: "A", status: "authorized", payer_email: "busca@x.com", last_modified: iso(0.01), date_created: iso(0.01) },
    { id: "B", status: "authorized", payer_email: "", last_modified: iso(0.01), date_created: iso(0.01) } ] });
  if (u === "/preapproval/A" || u === "/preapproval/B") return J({ id: u.slice(13), status: "authorized", payer_email: "", date_created: iso(0.01), last_modified: iso(0.01), auto_recurring: { free_trial: {} } });
  if (u.startsWith("/authorized_payments/search")) return J({ results: [] });
  return J({}, 404);
};
{ const j = await (await post()).json();
  check("consulta sem e-mail: usa o e-mail da busca", calls.some((c) => c[0] === "billing_sync" && c[1].p.email === "busca@x.com"));
  check("sem e-mail em lugar nenhum: não marca (tenta de novo no próximo ciclo)", !calls.some((c) => c[0] === "mp_sync_mark" && c[1].p_id === "B") && j.errors === 1, JSON.stringify(j)); }
// e-mail resolvido pela busca filtrada por candidata
st.cands = ["tai@x.com", "outra@x.com"]; calls.length = 0;
(globalThis as any).fetch = async (url: string) => {
  const u = url.replace("https://api.mercadopago.com", ""); const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.startsWith("/preapproval/search?limit=50&payer_email=tai%40x.com")) return J({ results: [{ id: "T" }] });
  if (u.startsWith("/preapproval/search?limit=50&payer_email=")) return J({ results: [] });
  if (u.startsWith("/preapproval/search")) return J({ paging: { total: 1 }, results: [{ id: "T", status: "authorized", payer_email: "", last_modified: iso(0.01), date_created: iso(0.01) }] });
  if (u === "/preapproval/T") return J({ id: "T", status: "authorized", payer_email: "", date_created: iso(0.01), last_modified: iso(0.01), auto_recurring: { free_trial: {} } });
  if (u.startsWith("/authorized_payments/search")) return J({ results: [] });
  return J({}, 404);
};
{ const j = await (await post()).json();
  check("sem e-mail: liga à candidata que o Mercado Pago confirmou", j.resolvedByEmail === 1 && calls.some((c) => c[0] === "billing_sync" && c[1].p.email === "tai@x.com"), JSON.stringify(j));
  check("e cria a conta/marca como processada", calls.some((c) => c[0] === "mp_sync_mark" && c[1].p_id === "T")); }
{ const m2 = await m.resolveEmails([]); check("sem candidatas: nada resolvido", m2.size === 0); }
(globalThis as any).fetch = async () => new Response(JSON.stringify({ results: [{ id: "X" }] }), { status: 200 });
{ const m3 = await m.resolveEmails(["a@x.com", "b@x.com"]); check("mesma assinatura para duas candidatas (filtro ignorado): não liga a ninguém", m3.get("X") === ""); }

// 0045: sem dona, resolvida, ligação manual e prioridade dos e-mails
st.cands = []; st.links = []; calls.length = 0;
(globalThis as any).fetch = async (url: string) => {
  const u = url.replace("https://api.mercadopago.com", ""); const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.startsWith("/preapproval/search?limit=50&payer_email=")) return J({ results: [] });
  if (u.startsWith("/preapproval/search")) return J({ paging: { total: 1 }, results: [{ id: "U", status: "authorized", payer_email: "", last_modified: iso(0.01), date_created: iso(0.01) }] });
  if (u === "/preapproval/U") return J({ id: "U", status: "authorized", payer_email: "", date_created: iso(0.01), last_modified: iso(0.01), auto_recurring: { free_trial: {}, transaction_amount: 59.9 } });
  if (u.startsWith("/authorized_payments/search")) return J({ results: [] });
  return J({}, 404);
};
{ const j = await (await post()).json(); const rep = calls.find((c) => c[0] === "mp_unlinked_report");
  check("sem e-mail em lugar nenhum: registrada como sem dona (painel e alerta)", j.unlinked === 1 && rep?.[1].p.preapproval_id === "U" && rep?.[1].p.amount === 59.9, JSON.stringify(j));
  check("sem dona: não marca e não cria conta", !calls.some((c) => c[0] === "mp_sync_mark") && !calls.some((c) => c[0] === "createUser")); }
st.links = [{ preapproval_id: "U", email: "ligada@x.com" }]; calls.length = 0;
{ const j = await (await post()).json();
  check("e-mail ligado no painel: libera no ciclo seguinte", j.resolvedManually === 1 && calls.some((c) => c[0] === "billing_sync" && c[1].p.email === "ligada@x.com") && calls.some((c) => c[0] === "createUser" && c[1].email === "ligada@x.com"), JSON.stringify(j));
  check("resolvida: sai da lista de sem dona", calls.some((c) => c[0] === "mp_unlinked_resolved" && c[1].p_id === "U")); }
{ const p = { id: "Z", payer_email: "" };
  check("prioridade: e-mail do Mercado Pago > busca confirmada > painel",
    m.pickEmail({ id: "Z", payer_email: "mp@x.com" }, new Map([["Z", "busca@x.com"]]), new Map([["Z", "painel@x.com"]])).via === "mp" &&
    m.pickEmail(p, new Map([["Z", "busca@x.com"]]), new Map([["Z", "painel@x.com"]])).email === "busca@x.com" &&
    m.pickEmail(p, new Map([["Z", ""]]), new Map([["Z", "painel@x.com"]])).email === "painel@x.com" &&
    m.pickEmail(p, new Map(), new Map()).via === "none"); }
console.info(`RESULTADO mp-sync: PASS=${pass} FAIL=${fail}`);
