// account-billing — a DONA cancela a própria assinatura pelo app (0051).
//   POST { action: "cancel", company_id, reason? }
//
// Publicar COM verificação de JWT (padrão). Autorização no banco, com a SESSÃO
// da usuária: owner_cancel_prepare só aceita a dona ativa da empresa e devolve a
// assinatura DELA (o navegador nunca escolhe qual assinatura cancelar). Só depois
// a função usa o token do Mercado Pago e a service role (billing_sync).
//
// Fonte da verdade = Mercado Pago: a conta só aparece como cancelada depois de o
// Mercado Pago confirmar, consultando a assinatura de novo (igual à admin-billing).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MP = "https://api.mercadopago.com";
const token = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Só o app chama esta função pelo navegador: produção e previews da Vercel deste
// projeto, no endereço atual (hive-beauty) e no novo (socia-beauty, roadmap 0.3).
const ORIGIN_OK = /^https:\/\/(hive|socia)-beauty(-[a-z0-9-]+)?\.vercel\.app$/;
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
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "account-billing", ...o }));

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

// --- IGUAL à da admin-billing e da mp-sync (o teste compara as três) -------------------
export function mapStatus(p: { status?: string; date_created?: string; auto_recurring?: { free_trial?: unknown } }) {
  if (p.status === "authorized") {
    const created = p.date_created ? Date.parse(p.date_created) : 0;
    const inTrial = !!p.auto_recurring?.free_trial && Date.now() - created < 7 * 86400000;
    return inTrial ? "trialing" : "active";
  }
  return p.status === "paused" ? "past_due" : p.status === "cancelled" ? "canceled" : "pending";
}
// ------------------------------------------------------------------------------------------

type Pre = {
  status?: string; payer_email?: string; payer_id?: string | number; next_payment_date?: string; date_created?: string;
  last_modified?: string; auto_recurring?: { free_trial?: unknown; transaction_amount?: number; currency_id?: string };
};
async function syncPreapproval(id: string) {
  const res = await mp(`/preapproval/${id}`);
  if (!res.ok) return { ok: false as const, detail: `MP ${res.status}: ${res.detail}` };
  const pre = res.data as Pre;
  const email = String(pre.payer_email ?? "").trim().toLowerCase();
  if (!email) return { ok: true as const, mpStatus: pre.status };
  const { error } = await service.rpc("billing_sync", {
    p: {
      email, status: mapStatus(pre), preapproval_id: id, mp_status: pre.status ?? null,
      next_payment_at: pre.next_payment_date ?? null, last_modified: pre.last_modified ?? null,
      amount: pre.auto_recurring?.transaction_amount ?? null, currency: pre.auto_recurring?.currency_id ?? null,
      payer_id: pre.payer_id != null ? String(pre.payer_id) : null, date_created: pre.date_created ?? null, source: "owner",
    },
  });
  if (error) return { ok: false as const, detail: `banco: ${error.message}` };
  return { ok: true as const, mpStatus: pre.status };
}

// Erro do banco -> status HTTP + texto para a dona (as mensagens do banco já são em português).
function dbError(req: Request, error: { code?: string; message?: string }) {
  const status = error.code === "42501" ? 403 : error.code === "55P03" ? 409 : error.code === "P0002" ? 404
    : error.code === "28000" ? 401 : 400;
  return json(req, status, { error: error.message ?? "Não foi possível cancelar agora.", code: error.code });
}

async function cancel(req: Request, user: ReturnType<typeof createClient>, companyId: string, reason: string) {
  const { data, error } = await user.rpc("owner_cancel_prepare", { p_company_id: companyId, p_reason: reason });
  if (error) return dbError(req, error);
  const { request_id, preapproval_id } = data as { request_id: string; preapproval_id: string };

  const put = await mp(`/preapproval/${preapproval_id}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
  // Confirma consultando de novo (também cobre "já estava cancelada" no Mercado Pago).
  const synced = await syncPreapproval(preapproval_id);
  const cancelled = synced.ok && synced.mpStatus === "cancelled";
  const detail = cancelled ? "cancelada no Mercado Pago" : !put.ok ? `MP ${put.status}: ${put.detail}` : synced.ok ? `MP ainda mostra ${synced.mpStatus}` : synced.detail;
  const fin = await user.rpc("owner_cancel_finish", { p_request_id: request_id, p_ok: cancelled, p_detail: detail });
  log({ action: "cancel", companyId, preapproval_id, cancelled, detail });
  if (!cancelled) {
    return json(req, 502, { error: "O Mercado Pago não confirmou o cancelamento. Tente de novo em alguns minutos.", detail });
  }
  return json(req, 200, { ok: true, access: (fin.data as { access?: unknown } | null)?.access ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Método não permitido." });
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(req, 401, { error: "Não autenticado." });
  if (!token) return json(req, 500, { error: "MP_ACCESS_TOKEN não configurado." });

  // Cliente com a sessão da usuária: o banco decide se ela é a dona.
  const user = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const body = await req.json().catch(() => ({}));
  if (body?.action === "cancel") {
    const companyId = String(body.company_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(companyId)) return json(req, 400, { error: "Conta inválida." });
    return cancel(req, user, companyId, String(body.reason ?? "").slice(0, 500));
  }
  return json(req, 400, { error: "Ação desconhecida." });
});
