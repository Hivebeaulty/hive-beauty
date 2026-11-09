// trial-signup — cadastro do teste grátis SEM CARTÃO (0052), na tela /cadastro do app.
//   POST { name, email, password, utm?, website? }
// Publicar SEM exigir JWT (quem se cadastra ainda não tem login).
// Passos: reserva o teste no banco (billing_start_trial: só e-mail que nunca teve
// login nem assinatura, até 5 cadastros por hora por IP) -> cria o login já
// confirmado, com a senha escolhida (sem e-mail de confirmação, que cairia no spam)
// -> se a criação falhar, desfaz a reserva. Depois o app entra com a senha e segue
// para o onboarding. No fim do teste, a dona assina no Mercado Pago com o mesmo e-mail.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const service = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false } });

// O app (produção, previews e o endereço novo do roadmap 0.3) e o site.
const ORIGIN_OK = /^https:\/\/(socia-beauty\.lovable\.app|id-preview--0d74345f-386a-4984-93f3-04929c0124cc\.lovable\.app|(hive|socia)-beauty(-[a-z0-9-]+)?\.vercel\.app|(www\.)?socia[a-z0-9-]*\.com\.br)$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(origin) ? origin : "https://hive-beauty.vercel.app",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

/** Valida o formulário. Devolve a mensagem para a pessoa, ou null se estiver tudo certo. */
export function validate(b: { name: string; email: string; password: string }): string | null {
  if (b.name.length < 2 || b.name.length > 80) return "Conte como você se chama.";
  if (!EMAIL_RE.test(b.email) || b.email.length > 254) return "Confira o e-mail digitado.";
  if (b.password.length < 8) return "A senha precisa ter pelo menos 8 caracteres.";
  if (b.password.length > 72) return "A senha pode ter no máximo 72 caracteres.";
  return null;
}

async function ipHash(req: Request): Promise<string | null> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (!ip) return null;
  const data = new TextEncoder().encode(`${ip}|${SERVICE_KEY.slice(-16)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "trial-signup", ...o }));
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");

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
    if (raw.length > 4000) return json(400, { error: "Pedido inválido." });
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Pedido inválido." });
  }
  // Campo escondido do formulário: só robôs preenchem.
  if (typeof body.website === "string" && body.website.trim()) return json(400, { error: "Pedido inválido." });

  const form = {
    name: String(body.name ?? "").trim().replace(/\s+/g, " "),
    email: String(body.email ?? "").trim().toLowerCase(),
    password: String(body.password ?? ""),
  };
  const invalid = validate(form);
  if (invalid) return json(400, { error: invalid });

  const { data: trial, error: te } = await service.rpc("billing_start_trial", { p_email: form.email, p_ip_hash: await ipHash(req) });
  if (te) {
    const known: Record<string, [number, string]> = {
      "23505": [409, te.message], "54000": [429, te.message], "22023": [400, "Confira o e-mail digitado."],
    };
    const [status, message] = known[te.code ?? ""] ?? [500, "Não foi possível criar a conta agora. Tente de novo."];
    log({ step: "start_trial", email: mask(form.email), code: te.code, error: te.message });
    return json(status, { error: message, code: te.code });
  }

  const created = await service.auth.admin.createUser({
    email: form.email, password: form.password, email_confirm: true, user_metadata: { full_name: form.name },
  });
  if (created.error) {
    await service.rpc("billing_trial_release", { p_email: form.email });
    const exists = created.error.status === 422;
    log({ step: "create_user", email: mask(form.email), status: created.error.status, error: created.error.message });
    return json(exists ? 409 : 500, {
      error: exists ? "Este e-mail já tem conta na Sócia. Entre com a sua senha." : "Não foi possível criar a conta agora. Tente de novo.",
    });
  }

  // Funil de aquisição do painel (o mesmo registro da landing). Falha aqui não impede o cadastro.
  const { error: ie } = await service.rpc("signup_intent_register", { p_email: form.email, p_utm: cleanUtm(body.utm) });
  log({ step: "ok", email: mask(form.email), intent: ie ? ie.message : "ok" });
  return json(200, { ok: true, trial_ends_at: (trial as { trial_ends_at?: string } | null)?.trial_ends_at ?? null });
});
