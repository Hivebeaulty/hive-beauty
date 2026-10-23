// admin-billing — ações do painel SuperAdmin que falam com o Mercado Pago (0040).
//   POST { action: "cancel", company_id, reason }  -> cancela a assinatura NO Mercado Pago
//   POST { action: "reconcile" }                    -> confere assinaturas e cobranças com o Mercado Pago
//
// Publicar COM verificação de JWT (padrão). Autorização em duas camadas:
//   1) o Supabase só deixa chegar aqui com JWT válido;
//   2) cada ação chama funções admin_* com a SESSÃO da usuária, que exigem
//      superadmin + MFA (aal2) no banco e gravam a auditoria.
// Só depois disso a função usa o token do Mercado Pago e a service role (para
// billing_sync / billing_record_payment). Nenhum segredo vai para o navegador.
//
// Fonte da verdade = Mercado Pago: o cancelamento só aparece como cancelado no banco
// depois de o Mercado Pago confirmar, consultando a assinatura de novo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MP = "https://api.mercadopago.com";
const token = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const RECONCILE_MAX = 200; // assinaturas por execução (evita estourar o tempo da função)

// Só o app (produção e previews da Vercel deste projeto) chama esta função pelo navegador.
const ORIGIN_OK = /^https:\/\/hive-beauty(-[a-z0-9-]+)?\.vercel\.app$/;
function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(o) ? o : "https://hive-beauty.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
const json = (req: Request, status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "admin-billing", ...o }));

type MpResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; detail: string };
async function mp(path: string, init: RequestInit = {}): Promise<MpResult> {
  try {
    const r = await fetch(`${MP}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (r.ok) return { ok: true, data: await r.json() };
    return { ok: false, status: r.status, detail: (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message.slice(0, 200) : "erro de rede" };
  }
}

// --- IGUAIS às do mp-webhook (o teste compara as duas) ---------------------------------
type Pay = {
  status?: string; status_detail?: string; transaction_amount?: number; transaction_amount_refunded?: number;
  fee_details?: { amount?: number; fee_payer?: string }[]; transaction_details?: { net_received_amount?: number };
  date_approved?: string; date_last_updated?: string; currency_id?: string;
};
type Ap = {
  id?: string | number; preapproval_id?: string; status?: string; transaction_amount?: number; currency_id?: string;
  debit_date?: string; last_modified?: string; retry_attempt?: number; rejection_code?: string;
  payment?: { id?: string | number; status?: string; status_detail?: string };
};
export function paymentRecord(ap: Ap, pay: Pay | null, email: string) {
  const apStatus = ap.status ?? "";
  const fromAp = apStatus === "scheduled" ? "scheduled" : apStatus === "recycling" ? "rejected"
    : apStatus === "cancelled" ? "cancelled" : "unknown";
  const fees = Array.isArray(pay?.fee_details)
    ? pay!.fee_details!.filter((f) => f.fee_payer === "collector").reduce((t, f) => t + (Number(f.amount) || 0), 0)
    : null;
  const mods = [ap.last_modified, pay?.date_last_updated].filter(Boolean).map((d) => Date.parse(d!)).filter((n) => !isNaN(n));
  return {
    authorized_payment_id: String(ap.id ?? ""),
    preapproval_id: String(ap.preapproval_id ?? ""),
    email,
    payment_id: ap.payment?.id != null ? String(ap.payment.id) : null,
    ap_status: apStatus || null,
    status: pay?.status ?? ap.payment?.status ?? fromAp,
    status_detail: pay?.status_detail ?? ap.payment?.status_detail ?? ap.rejection_code ?? null,
    amount: pay?.transaction_amount ?? ap.transaction_amount ?? null,
    refunded_amount: pay?.transaction_amount_refunded ?? 0,
    fee_amount: fees === null ? null : Math.round(fees * 100) / 100,
    net_amount: pay?.transaction_details?.net_received_amount ?? null,
    currency: pay?.currency_id ?? ap.currency_id ?? null,
    paid_at: pay?.date_approved ?? null,
    debit_date: ap.debit_date ?? null,
    retry_attempt: ap.retry_attempt ?? null,
    last_modified: mods.length ? new Date(Math.max(...mods)).toISOString() : null,
  };
}
export function mapStatus(p: { status?: string; date_created?: string; auto_recurring?: { free_trial?: unknown } }) {
  if (p.status === "authorized") {
    const created = p.date_created ? Date.parse(p.date_created) : 0;
    const inTrial = !!p.auto_recurring?.free_trial && Date.now() - created < 7 * 86400000;
    return inTrial ? "trialing" : "active";
  }
  return p.status === "paused" ? "past_due" : p.status === "cancelled" ? "canceled" : "pending";
}
// ----------------------------------------------------------------------------------------

type Pre = {
  status?: string; payer_email?: string; payer_id?: string | number; next_payment_date?: string; date_created?: string;
  last_modified?: string; auto_recurring?: { free_trial?: unknown; transaction_amount?: number; currency_id?: string };
};
async function syncPreapproval(id: string, source: "admin" | "reconcile") {
  const res = await mp(`/preapproval/${id}`);
  if (!res.ok) return { ok: false as const, detail: `MP ${res.status}: ${res.detail}` };
  const pre = res.data as Pre;
  const email = String(pre.payer_email ?? "").trim().toLowerCase();
  if (!email) return { ok: true as const, email: "", status: mapStatus(pre), mpStatus: pre.status };
  const { error } = await service.rpc("billing_sync", {
    p: {
      email, status: mapStatus(pre), preapproval_id: id, mp_status: pre.status ?? null,
      next_payment_at: pre.next_payment_date ?? null, last_modified: pre.last_modified ?? null,
      amount: pre.auto_recurring?.transaction_amount ?? null, currency: pre.auto_recurring?.currency_id ?? null,
      payer_id: pre.payer_id != null ? String(pre.payer_id) : null, date_created: pre.date_created ?? null, source,
    },
  });
  if (error) return { ok: false as const, detail: `banco: ${error.message}` };
  return { ok: true as const, email, status: mapStatus(pre), mpStatus: pre.status };
}

async function cancel(req: Request, user: ReturnType<typeof createClient>, companyId: string, reason: string) {
  const { data, error } = await user.rpc("admin_cancel_prepare", { p_company_id: companyId, p_reason: reason });
  if (error) return json(req, error.code === "42501" || error.code === "AUA01" ? 403 : 400, { error: error.message, code: error.code });
  const { preapproval_id, correlation_id } = data as { preapproval_id: string; correlation_id: string };

  const put = await mp(`/preapproval/${preapproval_id}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
  // Confirma consultando de novo (também cobre "já estava cancelada" no Mercado Pago).
  const synced = await syncPreapproval(preapproval_id, "admin");
  const cancelled = synced.ok && synced.mpStatus === "cancelled";
  const detail = cancelled ? "cancelada no Mercado Pago" : !put.ok ? `MP ${put.status}: ${put.detail}` : synced.ok ? `MP ainda mostra ${synced.mpStatus}` : synced.detail;
  await user.rpc("admin_cancel_finish", { p_company_id: companyId, p_correlation_id: correlation_id, p_ok: cancelled, p_detail: detail });
  log({ action: "cancel", companyId, preapproval_id, cancelled, detail });
  if (!cancelled) return json(req, 502, { error: "O Mercado Pago não confirmou o cancelamento.", detail });
  return json(req, 200, { ok: true, status: synced.ok ? synced.status : "canceled" });
}

async function reconcile(req: Request, user: ReturnType<typeof createClient>) {
  const { data, error } = await user.rpc("admin_reconcile_targets");
  if (error) return json(req, error.code === "42501" || error.code === "AUA01" ? 403 : 400, { error: error.message, code: error.code });
  const ids = ((data as string[]) ?? []).slice(0, RECONCILE_MAX);
  let checked = 0, payments = 0, errors = 0;
  const problems: string[] = [];
  for (const id of ids) {
    const s = await syncPreapproval(id, "reconcile");
    if (!s.ok) { errors++; problems.push(`${id}: ${s.detail}`); continue; }
    checked++;
    // Cobranças desta assinatura (pega reembolsos e estornos que não geram aviso de assinatura).
    const list = await mp(`/authorized_payments/search?preapproval_id=${encodeURIComponent(id)}&limit=50`);
    if (!list.ok) { errors++; problems.push(`${id} cobranças: MP ${list.status}`); continue; }
    for (const ap of ((list.data.results as Ap[]) ?? [])) {
      let pay: Pay | null = null;
      if (ap.payment?.id != null) {
        const pr = await mp(`/v1/payments/${ap.payment.id}`);
        if (pr.ok) pay = pr.data as Pay;
        else if (pr.status !== 404) { errors++; problems.push(`${id} pagamento ${ap.payment.id}: MP ${pr.status}`); continue; }
      }
      const { error: pe } = await service.rpc("billing_record_payment", { p: paymentRecord({ ...ap, preapproval_id: ap.preapproval_id ?? id }, pay, s.email) });
      if (pe) { errors++; problems.push(`${id} gravar cobrança: ${pe.message}`); } else payments++;
    }
  }
  const summary = { checked, payments, errors, skipped: Math.max(0, ((data as string[]) ?? []).length - ids.length), problems: problems.slice(0, 10) };
  await user.rpc("admin_log_reconcile", { p_details: summary });
  log({ action: "reconcile", ...summary });
  return json(req, errors ? 207 : 200, summary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Método não permitido." });
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(req, 401, { error: "Não autenticado." });
  if (!token) return json(req, 500, { error: "MP_ACCESS_TOKEN não configurado." });

  // Cliente com a sessão da usuária: o banco decide (superadmin + MFA) e audita.
  const user = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const body = await req.json().catch(() => ({}));
  if (body?.action === "cancel") {
    const companyId = String(body.company_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(companyId)) return json(req, 400, { error: "Conta inválida." });
    return cancel(req, user, companyId, String(body.reason ?? ""));
  }
  if (body?.action === "reconcile") return reconcile(req, user);
  return json(req, 400, { error: "Ação desconhecida." });
});
