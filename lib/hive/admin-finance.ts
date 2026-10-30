// ---------------------------------------------------------------------------
// SuperAdmin — Assinaturas e Financeiro (0040). Regras PURAS: interpretam a
// resposta de admin_finance_overview e formatam. Os números vêm do banco;
// aqui só se calcula o que é divisão (ticket médio, taxas), sem inventar nada.
// ---------------------------------------------------------------------------
import type { BadgeTone } from "@/components/ui/badge";

export type FinanceOverview = {
  measuring_since: string;
  gross_approved: number; refunded: number; charged_back: number; received: number;
  fees: number; fees_unknown: number; net: number; net_unknown: number;
  approved_count: number; paying_subscriptions: number;
  pending_amount: number; pending_count: number; rejected_amount: number; rejected_count: number;
  mrr_contracted: number; mrr_unknown: number; past_due_now: number;
  forecast_30d: number; trials_ending_30d: number;
  cohort_trials: number; cohort_converted: number; cohort_still_trial: number;
  churn_base: number; churn_canceled: number; trial_canceled: number;
  revenue_by_month: { month: string; received: number }[];
};

const NUM_KEYS: (keyof FinanceOverview)[] = [
  "gross_approved", "refunded", "charged_back", "received", "fees", "fees_unknown", "net", "net_unknown",
  "approved_count", "paying_subscriptions", "pending_amount", "pending_count", "rejected_amount", "rejected_count",
  "mrr_contracted", "mrr_unknown", "past_due_now", "forecast_30d", "trials_ending_30d",
  "cohort_trials", "cohort_converted", "cohort_still_trial", "churn_base", "churn_canceled", "trial_canceled",
];

/** Falha FECHADA: formato estranho -> null (a tela mostra erro, não números falsos). */
export function parseFinance(data: unknown): FinanceOverview | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of NUM_KEYS) {
    const n = typeof d[k] === "number" ? (d[k] as number) : typeof d[k] === "string" ? Number(d[k]) : NaN;
    if (!Number.isFinite(n)) return null;
    out[k] = n;
  }
  if (typeof d.measuring_since !== "string" || !Array.isArray(d.revenue_by_month)) return null;
  out.measuring_since = d.measuring_since;
  out.revenue_by_month = (d.revenue_by_month as { month?: unknown; received?: unknown }[])
    .filter((m) => typeof m?.month === "string")
    .map((m) => ({ month: m.month as string, received: Number(m.received) || 0 }));
  return out as FinanceOverview;
}

/** Divisão que não inventa: sem base, sem número. */
export const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
export const ticketMedio = (f: FinanceOverview) => ratio(f.received, f.paying_subscriptions);
export const conversionRate = (f: FinanceOverview) => ratio(f.cohort_converted, f.cohort_trials);
export const churnRate = (f: FinanceOverview) => ratio(f.churn_canceled, f.churn_base);
export function pct(v: number | null): string {
  if (v === null) return "—";
  return `${(Math.round(v * 1000) / 10).toLocaleString("pt-BR")}%`;
}

/** O período começa antes da medição? A tela avisa que o começo não tem dados. */
export function startsBeforeMeasuring(from: Date, measuringSince: string): boolean {
  const m = Date.parse(measuringSince);
  return Number.isFinite(m) && from.getTime() < m;
}

// --- rótulos -------------------------------------------------------------------------
export const PAYMENT_LABEL: Record<string, string> = {
  approved: "Aprovada", refunded: "Reembolsada", charged_back: "Estornada", pending: "Pendente",
  in_process: "Em análise", authorized: "Autorizada", scheduled: "Agendada", rejected: "Recusada",
  cancelled: "Cancelada", unknown: "Sem informação",
};
export const PAYMENT_TONE: Record<string, BadgeTone> = {
  approved: "success", refunded: "warning", charged_back: "danger", pending: "neutral", in_process: "neutral",
  authorized: "neutral", scheduled: "muted", rejected: "danger", cancelled: "muted", unknown: "muted",
};
export const EVENT_LABEL: Record<string, string> = {
  trialing: "Começou o teste", active: "Assinatura paga ativa", past_due: "Pagamento atrasado",
  pending: "Pagamento em análise", canceled: "Cancelada",
};
export const SOURCE_LABEL: Record<string, string> = { webhook: "aviso do Mercado Pago", reconcile: "conciliação", admin: "painel" };
export const paymentLabel = (s: string) => PAYMENT_LABEL[s] ?? s;
export const paymentTone = (s: string): BadgeTone => PAYMENT_TONE[s] ?? "muted";

// Definições mostradas na tela (as mesmas da migration 0040).
export const DEFINITIONS: [string, string][] = [
  ["Recebido", "Cobranças aprovadas no período, menos reembolsos e estornos. Valor bruto, antes das taxas."],
  ["Taxas e líquido", "Taxas do Mercado Pago pagas pela Sócia e o líquido que ele informa. Cobranças sem essa informação aparecem contadas à parte."],
  ["Pendente e recusado", "Cobranças agendadas, em análise ou recusadas no período. Não entram na receita."],
  ["Ticket médio", "Recebido dividido pelo número de assinaturas que pagaram no período."],
  ["MRR contratado", "Soma do valor mensal das assinaturas pagas ativas hoje. Teste, cortesia e atrasadas não entram."],
  ["Conversão", "Das assinaturas que começaram em teste no período, quantas já tiveram uma cobrança aprovada. As que ainda estão em teste aparecem à parte."],
  ["Churn pago", "Assinaturas pagas no início do período que foram canceladas nele, divididas pelas pagas no início."],
  ["Previsão", "Valor mensal das assinaturas ativas ou atrasadas com cobrança prevista nos próximos 30 dias. É previsão, não receita."],
];

/** Erro da função admin-billing em texto para a tela. */
export function billingActionError(status: number, body: { error?: string; detail?: string; code?: string } | null): string {
  if (status === 401 || status === 403 || body?.code === "AUA01") {
    return body?.code === "AUA01"
      ? "Sua verificação em duas etapas expirou. Recarregue a página para confirmar de novo."
      : "Sua conta não tem permissão para esta ação.";
  }
  if (status === 502) return `O Mercado Pago não confirmou o cancelamento. ${body?.detail ?? ""}`.trim();
  return body?.error ?? "Não foi possível concluir. Tente de novo.";
}
