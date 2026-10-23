// ---------------------------------------------------------------------------
// SuperAdmin — Aquisição (0041). Regras PURAS: leem admin_funnel e calculam taxas.
// O funil compara TOTAIS do período: o link do checkout é o mesmo para todas, então
// não dá para ligar uma visita a uma assinatura específica.
// ---------------------------------------------------------------------------

export type Funnel = {
  measuring_since: string | null;
  visitors: number; pageviews: number; clickers: number; cta_clicks: number;
  whatsapp_clicks: number; login_clicks: number;
  trials_started: number; first_payments: number; paying_now: number;
  by_origin: { origin: string; visitors: number; clickers: number }[];
  by_device: Record<string, number>;
  by_cta: Record<string, number>;
  by_campaign: { campaign: string; source: string | null; visitors: number; clickers: number }[];
  by_day: { day: string; visitors: number; clickers: number }[];
};

const NUMS = ["visitors", "pageviews", "clickers", "cta_clicks", "whatsapp_clicks", "login_clicks",
  "trials_started", "first_payments", "paying_now"] as const;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const counts = (o: unknown): Record<string, number> => {
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  return Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, num(v) || 0]));
};

/** Falha FECHADA: formato inesperado -> null (a tela mostra erro, não números falsos). */
export function parseFunnel(data: unknown): Funnel | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of NUMS) {
    const n = num(d[k]);
    if (!Number.isFinite(n)) return null;
    out[k] = n;
  }
  for (const k of ["by_origin", "by_campaign", "by_day"]) if (!Array.isArray(d[k])) return null;
  out.measuring_since = typeof d.measuring_since === "string" ? d.measuring_since : null;
  out.by_origin = (d.by_origin as Record<string, unknown>[]).map((r) => ({ origin: String(r.origin ?? "direto"), visitors: num(r.visitors) || 0, clickers: num(r.clickers) || 0 }));
  out.by_campaign = (d.by_campaign as Record<string, unknown>[]).map((r) => ({
    campaign: String(r.campaign ?? ""), source: r.source == null ? null : String(r.source), visitors: num(r.visitors) || 0, clickers: num(r.clickers) || 0 }));
  out.by_day = (d.by_day as Record<string, unknown>[]).filter((r) => typeof r.day === "string")
    .map((r) => ({ day: String(r.day), visitors: num(r.visitors) || 0, clickers: num(r.clickers) || 0 }));
  out.by_device = counts(d.by_device);
  out.by_cta = counts(d.by_cta);
  return out as Funnel;
}

/** Etapas do funil com a taxa em relação à etapa anterior (null quando não há base). */
export function funnelSteps(f: Funnel) {
  const steps = [
    { key: "visitors", label: "Visitantes da página inicial", value: f.visitors, source: "site" },
    { key: "clickers", label: "Clicaram para assinar", value: f.clickers, source: "site" },
    { key: "trials", label: "Começaram o teste grátis", value: f.trials_started, source: "Mercado Pago" },
    { key: "first_payments", label: "Fizeram o primeiro pagamento", value: f.first_payments, source: "Mercado Pago" },
  ] as const;
  return steps.map((s, i) => ({ ...s, rate: i === 0 ? null : steps[i - 1].value > 0 ? s.value / steps[i - 1].value : null }));
}

export const DEVICE_LABEL: Record<string, string> = { mobile: "Celular", tablet: "Tablet", desktop: "Computador" };
export const CTA_LABEL: Record<string, string> = { topo: "Topo", abertura: "Abertura", plano: "Plano", final: "Final", sem_nome: "Sem identificação" };

/** Nome amigável da origem: "direto", domínios e utm_source. */
export function originLabel(o: string): string {
  if (o === "direto") return "Direto (link, digitado ou app)";
  const known: Record<string, string> = { "instagram.com": "Instagram", instagram: "Instagram", "facebook.com": "Facebook", facebook: "Facebook",
    "google.com": "Google", google: "Google", "t.co": "X (Twitter)", "wa.me": "WhatsApp", whatsapp: "WhatsApp", "tiktok.com": "TikTok", tiktok: "TikTok" };
  return known[o] ?? o;
}
