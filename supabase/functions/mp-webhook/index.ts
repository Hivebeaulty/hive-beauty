// mp-webhook — avisos do Mercado Pago (Planos e assinaturas).
// 1) confere a assinatura secreta (x-signature, HMAC-SHA256) — recusa avisos falsos;
// 2) consulta a assinatura NO PRÓPRIO Mercado Pago (não confia no corpo do aviso);
// 3) grava a situação e o histórico (billing_sync, 0039) e cada cobrança com o pagamento
//    gerado (billing_record_payment: bruto, taxa, líquido, reembolso);
// 4) se é assinatura nova, cria a conta e envia o e-mail "Crie uma nova senha na Sócia".
// Segredos (Supabase → Edge Functions → Secrets): MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET.
// Publicar SEM exigir JWT (o Mercado Pago não envia JWT; a segurança é a assinatura secreta).
//
// Respostas: 200 = tratado (ou ignorado de propósito); 401 = assinatura inválida;
// 500 = falha passageira -> o Mercado Pago reenvia o aviso. Tudo é idempotente:
// reprocessar o mesmo aviso grava a mesma situação e não cria conta em dobro.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MP = "https://api.mercadopago.com";
// Link do e-mail de senha: precisa abrir a tela que valida o link e grava a senha.
// (Este endereço tem de estar em Authentication → URL Configuration → Redirect URLs.)
const APP_URL = "https://hive-beauty.vercel.app";
const token = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const secret = Deno.env.get("MP_WEBHOOK_SECRET") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validSignature(req: Request, dataId: string) {
  const parts = Object.fromEntries((req.headers.get("x-signature") ?? "").split(",").map((p) => p.trim().split("=") as [string, string]));
  const requestId = req.headers.get("x-request-id") ?? "";
  if (!secret || !parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  return (await hmacHex(secret, manifest)) === parts.v1;
}

// Consulta ao Mercado Pago. "retry" = falha passageira (rede, 429, 5xx, token):
// responder 500 para o aviso voltar. 404 = id inexistente (ex.: simulação do painel): não volta.
// "detail" = mensagem de erro do Mercado Pago (sem token nem dados de cartão), para o log.
type MpResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; retry: boolean; detail: string };
async function mp(path: string): Promise<MpResult> {
  try {
    const r = await fetch(`${MP}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return { ok: true, data: await r.json() };
    const detail = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    return { ok: false, status: r.status, retry: r.status !== 404 && r.status !== 400, detail };
  } catch (e) {
    return { ok: false, status: 0, retry: true, detail: e instanceof Error ? e.message.slice(0, 200) : "erro de rede" };
  }
}

// Tipo do token, sem revelá-lo: produção começa com APP_USR-, teste com TEST-.
const tokenKind = token.startsWith("APP_USR-") ? "producao" : token.startsWith("TEST-") ? "teste" : token ? "desconhecido" : "ausente";

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

// Cobrança (authorized_payment) + pagamento gerado (/v1/payments) -> linha de billing_payments.
// O pagamento, quando existe, é a fonte mais atual (aprovado, recusado, reembolsado, estornado).
// Sem cartão, documento ou endereço: só ids, valores e datas.
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

function mapStatus(p: { status?: string; date_created?: string; auto_recurring?: { free_trial?: unknown } }) {
  if (p.status === "authorized") {
    const created = p.date_created ? Date.parse(p.date_created) : 0;
    const inTrial = !!p.auto_recurring?.free_trial && Date.now() - created < 7 * 86400000;
    return inTrial ? "trialing" : "active";
  }
  return p.status === "paused" ? "past_due" : p.status === "cancelled" ? "canceled" : "pending";
}

// Nos logs, o e-mail aparece mascarado (ta***@gmail.com).
const mask = (e: string) => e.replace(/^(.{0,2})[^@]*(@.*)?$/, (_, a, d) => `${a}***${d ?? ""}`);
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "mp-webhook", ...o }));
const reply = (status: number, text: string, info: Record<string, unknown> = {}) => {
  log({ http: status, result: text, ...info });
  return new Response(text, { status });
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const type = String(body?.type ?? url.searchParams.get("type") ?? "");
  const dataId = String(body?.data?.id ?? url.searchParams.get("data.id") ?? "");
  if (!dataId) return reply(200, "ok", { type, note: "sem data.id" });
  if (!(await validSignature(req, dataId))) return reply(401, "assinatura inválida", { type, dataId });

  let preapprovalId = dataId;
  let ap: Ap | null = null;
  let payment: Pay | null = null;
  if (type === "subscription_authorized_payment") {
    const res = await mp(`/authorized_payments/${dataId}`);
    if (!res.ok) return reply(res.retry ? 500 : 200, "pagamento não consultado", { type, dataId, mp: res.status, mpDetail: res.detail, tokenKind });
    ap = res.data as Ap;
    preapprovalId = String(ap.preapproval_id ?? "");
    if (ap.payment?.id != null) {
      const pr = await mp(`/v1/payments/${ap.payment.id}`);
      if (pr.ok) payment = pr.data as Pay;
      else if (pr.retry) return reply(500, "pagamento não consultado", { type, dataId, paymentId: ap.payment.id, mp: pr.status, mpDetail: pr.detail });
      // 404: segue só com os dados da cobrança
    }
  } else if (type !== "subscription_preapproval") {
    return reply(200, "ignorado", { type, dataId });
  }
  if (!preapprovalId) return reply(200, "sem assinatura", { type, dataId });

  const res = await mp(`/preapproval/${preapprovalId}`);
  if (!res.ok) return reply(res.retry ? 500 : 200, "assinatura não consultada", { type, preapprovalId, mp: res.status, mpDetail: res.detail, tokenKind });
  const pre = res.data as {
    status?: string; payer_email?: string; payer_id?: string | number; next_payment_date?: string; date_created?: string;
    last_modified?: string; auto_recurring?: { free_trial?: unknown; transaction_amount?: number; currency_id?: string };
  };
  const email = String(pre.payer_email ?? "").trim().toLowerCase();
  const status = mapStatus(pre);
  // Cobrança primeiro (mesmo sem e-mail o dinheiro fica registrado); depois situação e histórico.
  let payStatus: string | null = null;
  if (ap) {
    const rec = paymentRecord(ap, payment, email);
    const { data: pd, error: pe } = await admin.rpc("billing_record_payment", { p: rec });
    if (pe) return reply(500, "erro ao gravar cobrança", { preapprovalId, email: email ? mask(email) : null, db: pe.message });
    payStatus = (pd as { status?: string } | null)?.status ?? rec.status;
  }
  if (!email) return reply(200, "sem e-mail", { type, preapprovalId, mpStatus: pre.status, status, payStatus });

  const { data: synced, error } = await admin.rpc("billing_sync", {
    p: {
      email, status, preapproval_id: preapprovalId, mp_status: pre.status ?? null,
      next_payment_at: pre.next_payment_date ?? null, last_modified: pre.last_modified ?? null,
      amount: pre.auto_recurring?.transaction_amount ?? null, currency: pre.auto_recurring?.currency_id ?? null,
      payer_id: pre.payer_id != null ? String(pre.payer_id) : null, date_created: pre.date_created ?? null, source: "webhook",
    },
  });
  if (error) return reply(500, "erro ao gravar", { preapprovalId, email: mask(email), status, db: error.message });
  const saved = (synced as { status?: string } | null)?.status ?? null;

  let account = "sem conta (situação não libera)";
  if (status === "trialing" || status === "active") {
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error) {
      // 422 = e-mail já cadastrado: conta existente, mantém a senha dela. Outro erro: tenta de novo.
      if (created.error.status !== 422) {
        return reply(500, "erro ao criar conta", { preapprovalId, email: mask(email), status, auth: created.error.message });
      }
      account = "conta já existia";
    } else {
      const sent = await admin.auth.resetPasswordForEmail(email, { redirectTo: `${APP_URL}/redefinir-senha` });
      // Sem repetir em caso de erro: a conta já existe, e ela pode usar "Esqueci minha senha".
      account = sent.error ? `conta criada, e-mail NÃO enviado: ${sent.error.message}` : "conta criada, e-mail de senha enviado";
    }
  }
  return reply(200, "ok", { type, preapprovalId, email: mask(email), mpStatus: pre.status, status, saved, payStatus, account });
});
