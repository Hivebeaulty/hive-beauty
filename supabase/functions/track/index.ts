// track — eventos anônimos da landing (0041). Publicar SEM exigir JWT (o site é público).
//
// Privacidade (é isto que a Política de Privacidade descreve):
//   * Sem cookie e sem armazenamento no aparelho da visitante.
//   * O IP e o navegador só entram no cálculo do identificador do dia
//     (sha256 de sal do dia + IP + navegador, 16 caracteres) e são descartados.
//     O sal muda todo dia e o antigo é apagado: o identificador não pode ser refeito.
//   * Da página de origem só fica o domínio (ex.: instagram.com), nunca o endereço completo.
//   * Lista fechada de eventos e campos; textos cortados no tamanho máximo.
// Defesas: só aceita os domínios do site, ignora robôs, limita 300 eventos por visitante/dia
// (no banco) e responde sempre 204 (não revela nada a quem testar a função).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Site publicado, prévia do Lovable deste projeto e um domínio próprio futuro (socia*.com.br).
const ORIGIN_OK = /^https:\/\/(socia-beauty\.lovable\.app|id-preview--0d74345f-386a-4984-93f3-04929c0124cc\.lovable\.app|(www\.)?socia[a-z0-9-]*\.com\.br)$/;
const EVENTS = new Set(["pageview", "cta_click", "whatsapp_click", "login_click"]);
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime|curl|wget|python|axios/i;

export function deviceOf(ua: string): "mobile" | "tablet" | "desktop" {
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

/** Só o domínio da origem, sem o próprio site (navegação interna não é "origem"). */
export function referrerHost(ref: unknown, ownHost: string): string | null {
  if (typeof ref !== "string" || !ref) return null;
  try {
    const h = new URL(ref).hostname.toLowerCase().replace(/^www\./, "").replace(/^(m|l|lm)\.(facebook|instagram)\.com$/, "$2.com");
    return h && h !== ownHost ? h.slice(0, 100) : null;
  } catch {
    return null;
  }
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : null) || null;

async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(origin) ? origin : "https://socia-beauty.lovable.app",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const done = () => new Response(null, { status: 204, headers: cors(origin) });
  if (req.method === "OPTIONS") return done();
  if (req.method !== "POST" || !ORIGIN_OK.test(origin)) return done();
  const ua = req.headers.get("user-agent") ?? "";
  if (!ua || BOT.test(ua)) return done();

  // sendBeacon manda text/plain (sem preflight): o corpo é JSON em texto.
  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.length > 2000) return done();
    body = JSON.parse(raw);
  } catch {
    return done();
  }
  const event = String(body.e ?? "");
  if (!EVENTS.has(event)) return done();

  const { data: salt, error: se } = await service.rpc("analytics_daily_salt");
  if (se || typeof salt !== "string") return done();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
  const visitor = (await sha256hex(`${salt}|${ip}|${ua}`)).slice(0, 16);

  const ownHost = new URL(origin).hostname.replace(/^www\./, "");
  const utm = (body.u && typeof body.u === "object" ? body.u : {}) as Record<string, unknown>;
  await service.rpc("analytics_ingest", {
    p: {
      event,
      visitor,
      path: clip(body.p, 120) ?? "/",
      referrer_host: referrerHost(body.r, ownHost),
      utm_source: clip(utm.utm_source, 60),
      utm_medium: clip(utm.utm_medium, 60),
      utm_campaign: clip(utm.utm_campaign, 100),
      device: deviceOf(ua),
      cta: clip(body.c, 40),
    },
  });
  return done();
});
