// mp-sync — busca as assinaturas NO Mercado Pago, sem depender do aviso (webhook) (0043).
//
// Por quê: assinaturas feitas por um link de plano criado no painel do Mercado Pago podem
// não disparar o webhook da aplicação. Sem o aviso, a conta não era liberada.
// A cada 5 minutos o pg_cron chama esta função (segredo do Vault em x-cron-secret).
// Ela lista as assinaturas alteradas nos últimos 30 dias, e para cada uma nova ou mudada:
//   1) consulta a assinatura (/preapproval/{id}) e grava situação e histórico (billing_sync);
//   2) traz as cobranças dela (/authorized_payments/search + /v1/payments) (billing_record_payment);
//   3) se a situação libera (teste ou ativa) e a conta não existe: cria a conta e envia o
//      e-mail de senha — exatamente como a mp-webhook.
// E-mail: assinaturas por link de plano vêm com payer_email vazio. Ordem de busca:
//   a) payer_email da própria assinatura;
//   b) a busca do Mercado Pago com o filtro payer_email, para cada candidata
//      (mp_sync_candidates: contas sem acesso + e-mails informados no site antes do checkout, 0045);
//   c) o e-mail ligado manualmente no painel (mp_manual_links, auditado, 0045).
// Sem e-mail: registra a assinatura como "sem dona" (mp_unlinked: painel + alerta ao suporte),
// não marca e tenta de novo no próximo ciclo. Resolvida: sai da lista.
// Idempotente: rodar de novo grava o mesmo e não cria conta em dobro. Publicar SEM JWT.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MP = "https://api.mercadopago.com";
const APP_URL = "https://hive-beauty.vercel.app";
const token = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const WINDOW_DAYS = 30;
const MAX_PAGES = 20; // 50 por página

type MpResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; detail: string };
async function mp(path: string): Promise<MpResult> {
  try {
    const r = await fetch(`${MP}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return { ok: true, data: await r.json() };
    return { ok: false, status: r.status, detail: (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message.slice(0, 200) : "erro de rede" };
  }
}

// --- IGUAIS às da mp-webhook (o teste compara as duas) ---------------------------------
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

const mask = (e: string) => e.replace(/^(.{0,2})[^@]*(@.*)?$/, (_, a, d) => `${a}***${d ?? ""}`);
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "mp-sync", ...o }));

type Pre = {
  id?: string; status?: string; payer_email?: string; payer_id?: string | number; next_payment_date?: string; date_created?: string;
  last_modified?: string; auto_recurring?: { free_trial?: unknown; transaction_amount?: number; currency_id?: string };
};

/** Lista as assinaturas alteradas na janela (a busca pode trazer o e-mail vazio: a consulta individual traz). */
export async function listRecent(now = Date.now()) {
  const since = now - WINDOW_DAYS * 86400000; const out: Pre[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await mp(`/preapproval/search?limit=50&offset=${page * 50}`);
    if (!r.ok) return { ok: false as const, error: `MP ${r.status}: ${r.detail}`, items: out };
    const results = (r.data.results as Pre[]) ?? [];
    for (const p of results) {
      const mod = Date.parse(p.last_modified ?? p.date_created ?? "");
      if (p.id && !isNaN(mod) && mod >= since) out.push(p);
    }
    const total = Number((r.data.paging as { total?: number } | undefined)?.total ?? 0);
    if (results.length < 50 || (page + 1) * 50 >= total) break;
  }
  return { ok: true as const, items: out };
}

/** Para cada candidata, quais assinaturas o Mercado Pago diz que são dela (id -> e-mail). */
export async function resolveEmails(candidates: string[]) {
  const map = new Map<string, string>();
  for (const email of candidates) {
    const r = await mp(`/preapproval/search?limit=50&payer_email=${encodeURIComponent(email)}`);
    if (!r.ok) continue;
    for (const p of ((r.data.results as Pre[]) ?? [])) {
      if (!p.id) continue;
      // Mesmo id para duas candidatas = filtro não confiável: não liga a ninguém.
      if (map.has(p.id) && map.get(p.id) !== email) map.set(p.id, ""); else if (!map.has(p.id)) map.set(p.id, email);
    }
  }
  return map;
}

/** E-mail da assinatura: o do Mercado Pago, o confirmado pela busca, ou o ligado no painel. */
export function pickEmail(p: Pre, byEmail: Map<string, string>, manual: Map<string, string>) {
  const own = String(p.payer_email ?? "").trim();
  if (own) return { email: own, via: "mp" };
  const found = byEmail.get(p.id!) ?? "";
  if (found) return { email: found, via: "search" };
  const linked = manual.get(p.id!) ?? "";
  if (linked) return { email: linked, via: "manual" };
  return { email: "", via: "none" };
}

async function syncOne(id: string, searchEmail = "") {
  const res = await mp(`/preapproval/${id}`);
  if (!res.ok) return { ok: false, error: `assinatura ${id}: MP ${res.status}` };
  const pre = res.data as Pre;
  const email = (String(pre.payer_email ?? "").trim() || searchEmail.trim()).toLowerCase();
  if (!email) {
    // Diagnóstico sem dados pessoais: quais campos vieram e se há e-mail em algum deles.
    const keys = Object.keys(pre as Record<string, unknown>).sort();
    const payer = (pre as Record<string, unknown>).payer as Record<string, unknown> | undefined;
    log({ preapprovalId: id, note: "sem e-mail", keys, payerKeys: payer ? Object.keys(payer).sort() : null,
          hasPayerId: pre.payer_id != null, externalReference: (pre as Record<string, unknown>).external_reference ?? null,
          emailLike: keys.filter((k) => /mail/i.test(k)) });
    await admin.rpc("mp_unlinked_report", { p: { preapproval_id: id, mp_status: pre.status ?? null,
      amount: pre.auto_recurring?.transaction_amount ?? null, date_created: pre.date_created ?? null } });
    return { ok: false, noEmail: true, error: "assinatura sem e-mail (registrada como sem dona)" };
  }
  const status = mapStatus(pre);
  const { error } = await admin.rpc("billing_sync", { p: {
    email, status, preapproval_id: id, mp_status: pre.status ?? null, next_payment_at: pre.next_payment_date ?? null,
    last_modified: pre.last_modified ?? null, amount: pre.auto_recurring?.transaction_amount ?? null,
    currency: pre.auto_recurring?.currency_id ?? null, payer_id: pre.payer_id != null ? String(pre.payer_id) : null,
    date_created: pre.date_created ?? null, source: "reconcile",
  } });
  if (error) return { ok: false, error: `gravar ${id}: ${error.message}` };

  // Cobranças desta assinatura
  let payments = 0;
  const list = await mp(`/authorized_payments/search?preapproval_id=${encodeURIComponent(id)}&limit=50`);
  if (list.ok) {
    for (const ap of ((list.data.results as Ap[]) ?? [])) {
      let pay: Pay | null = null;
      if (ap.payment?.id != null) { const pr = await mp(`/v1/payments/${ap.payment.id}`); if (pr.ok) pay = pr.data as Pay; }
      const { error: pe } = await admin.rpc("billing_record_payment", { p: paymentRecord({ ...ap, preapproval_id: ap.preapproval_id ?? id }, pay, email) });
      if (!pe) payments++;
    }
  }

  // Conta e e-mail de senha (como a mp-webhook)
  let account = "sem conta (situação não libera)";
  if (status === "trialing" || status === "active") {
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error) {
      if (created.error.status !== 422) return { ok: false, error: `criar conta: ${created.error.message}` };
      account = "conta já existia";
    } else {
      const sent = await admin.auth.resetPasswordForEmail(email, { redirectTo: `${APP_URL}/redefinir-senha` });
      account = sent.error ? `conta criada, e-mail NÃO enviado: ${sent.error.message}` : "conta criada, e-mail de senha enviado";
    }
  }
  await admin.rpc("mp_unlinked_resolved", { p_id: id });
  log({ preapprovalId: id, email: mask(email), mpStatus: pre.status, status, payments, account });
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Método não permitido.", { status: 405 });
  const { data: okSecret } = await admin.rpc("mp_sync_secret_ok", { p_secret: req.headers.get("x-cron-secret") ?? "" });
  if (okSecret !== true) return new Response("Não autorizado.", { status: 401 });
  if (!token) return new Response(JSON.stringify({ error: "MP_ACCESS_TOKEN ausente" }), { status: 500 });

  const listed = await listRecent();
  if (!listed.ok) { log({ error: listed.error }); return new Response(JSON.stringify({ error: listed.error }), { status: 502 }); }
  // Só o que é novo ou mudou desde a última gravação
  const { data: known, error } = await admin.rpc("mp_sync_known", { p_ids: listed.items.map((p) => p.id) });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const lastMod = new Map<string, string | null>(((known as { id: string; last_modified: string | null }[]) ?? []).map((k) => [k.id, k.last_modified]));
  const todo = listed.items.filter((p) => {
    const k = lastMod.get(p.id!); return k == null || Date.parse(p.last_modified ?? "") > Date.parse(k);
  });
  const summary = { listed: listed.items.length, synced: 0, errors: 0, unlinked: 0, resolvedByEmail: 0, resolvedManually: 0 };
  // Só consulta candidatas e ligações manuais se houver assinatura nova sem e-mail na busca.
  let byEmail = new Map<string, string>(); let manual = new Map<string, string>();
  if (todo.some((p) => !String(p.payer_email ?? "").trim())) {
    const { data: cands } = await admin.rpc("mp_sync_candidates");
    byEmail = await resolveEmails(((cands as string[]) ?? []).filter(Boolean));
    const { data: links } = await admin.rpc("mp_manual_links");
    manual = new Map(((links as { preapproval_id: string; email: string }[]) ?? []).map((l) => [l.preapproval_id, l.email]));
  }
  for (const p of todo) {
    const pick = pickEmail(p, byEmail, manual);
    if (pick.via === "search") summary.resolvedByEmail++;
    if (pick.via === "manual") summary.resolvedManually++;
    const r = await syncOne(p.id!, pick.email);
    if (r.ok) {
      summary.synced++;
      await admin.rpc("mp_sync_mark", { p_id: p.id, p_last_modified: p.last_modified ?? p.date_created ?? null });
    } else {
      summary.errors++;
      if ((r as { noEmail?: boolean }).noEmail) summary.unlinked++;
      log({ preapprovalId: p.id, error: r.error });
    }
  }
  if (todo.length) log(summary);
  return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
});
