// signup-intent — e-mail informado no site ANTES de abrir o checkout do Mercado Pago (0045).
// Publicar SEM exigir JWT (o site é público). O link de plano do Mercado Pago não informa
// o e-mail de quem assina; com este registro, a mp-sync encontra a assinatura (busca do
// Mercado Pago com o filtro payer_email) e cria a conta da cliente nova.
// Guarda só: e-mail e UTM. Aceita apenas os domínios do site e do app.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const ORIGIN_OK = /^https:\/\/(aurea-hivebeauty\.lovable\.app|id-preview--0d74345f-386a-4984-93f3-04929c0124cc\.lovable\.app|hive-beauty(-[a-z0-9-]+)?\.vercel\.app|(www\.)?aurea[a-z0-9-]*\.com\.br)$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(origin) ? origin : "https://aurea-hivebeauty.lovable.app",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}

export function cleanUtm(u: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!u || typeof u !== "object") return out;
  for (const k of UTM_KEYS) {
    const v = (u as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 100);
  }
  return out;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "Método não permitido." });
  if (!ORIGIN_OK.test(origin)) return json(403, { error: "Origem não permitida." });

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.length > 2000) return json(400, { error: "Pedido inválido." });
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Pedido inválido." });
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json(400, { error: "Confira o e-mail digitado." });

  const { error } = await service.rpc("signup_intent_register", { p_email: email, p_utm: cleanUtm(body.utm) });
  if (error) {
    const busy = error.code === "P0001";
    console.log(JSON.stringify({ fn: "signup-intent", error: error.message }));
    return json(busy ? 429 : 500, { error: busy ? "Muitos cadastros agora. Tente de novo em alguns minutos." : "Não foi possível continuar. Tente de novo." });
  }
  return json(200, { ok: true });
});
