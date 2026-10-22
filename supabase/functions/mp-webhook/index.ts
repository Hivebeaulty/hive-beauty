// mp-webhook — avisos do Mercado Pago (Planos e assinaturas).
// 1) confere a assinatura secreta (x-signature, HMAC-SHA256) — recusa avisos falsos;
// 2) consulta a assinatura NO PRÓPRIO Mercado Pago (não confia no corpo do aviso);
// 3) grava a situação (billing_upsert) e, se é assinatura nova, cria a conta e envia
//    o e-mail "Crie uma nova senha na Áurea" (mesmo fluxo da recuperação de senha).
// Segredos (Supabase → Edge Functions → Secrets): MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MP = "https://api.mercadopago.com";
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

const mp = (path: string) => fetch(`${MP}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() : null));

function mapStatus(p: { status?: string; date_created?: string; next_payment_date?: string; auto_recurring?: { free_trial?: unknown } }) {
  if (p.status === "authorized") {
    const created = p.date_created ? Date.parse(p.date_created) : 0;
    const inTrial = !!p.auto_recurring?.free_trial && Date.now() - created < 7 * 86400000;
    return inTrial ? "trialing" : "active";
  }
  return p.status === "paused" ? "past_due" : p.status === "cancelled" ? "canceled" : "pending";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const type = String(body?.type ?? url.searchParams.get("type") ?? "");
  const dataId = String(body?.data?.id ?? url.searchParams.get("data.id") ?? "");
  if (!dataId) return new Response("ok", { status: 200 });
  if (!(await validSignature(req, dataId))) return new Response("assinatura inválida", { status: 401 });

  let preapprovalId = dataId;
  if (type === "subscription_authorized_payment") {
    const pay = await mp(`/authorized_payments/${dataId}`);
    preapprovalId = pay?.preapproval_id ?? "";
  } else if (type !== "subscription_preapproval") {
    return new Response("ignorado", { status: 200 });
  }
  const pre = preapprovalId ? await mp(`/preapproval/${preapprovalId}`) : null;
  const email = String(pre?.payer_email ?? "").trim().toLowerCase();
  if (!pre || !email) return new Response("sem e-mail", { status: 200 });

  const status = mapStatus(pre);
  const { error } = await admin.rpc("billing_upsert", { p_email: email, p_status: status, p_preapproval_id: preapprovalId, p_next_payment_at: pre.next_payment_date ?? null });
  if (error) return new Response("erro ao gravar", { status: 500 }); // o Mercado Pago tenta de novo

  if (status === "trialing" || status === "active") {
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (!created.error) await admin.auth.resetPasswordForEmail(email); // conta nova: e-mail para criar a senha
  }
  return new Response("ok", { status: 200 });
});
