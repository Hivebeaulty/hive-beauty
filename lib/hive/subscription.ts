// Assinatura vista pela dona no app (0051). Lógica PURA: interpreta a resposta de
// my_subscription e escolhe os textos da tela Mais > Assinatura.
// Datas sempre no fuso de Brasília; valores em reais.
import { parseAccess, type Access } from "./access";

export type SubPayment = { at: string; status: string; amount: number | null; refunded: number };
export type Subscription = {
  status: "free" | "trialing" | "active" | "past_due" | "canceled" | "pending" | "none";
  amount: number | null;
  trialEndsAt: string | null;
  nextPaymentAt: string | null;
  canceledAt: string | null;
  access: Access;
  canCancel: boolean;
  cancelPending: boolean;
  payments: SubPayment[];
};

const STATUSES: Subscription["status"][] = ["free", "trialing", "active", "past_due", "canceled", "pending", "none"];
const iso = (v: unknown) => (typeof v === "string" && !isNaN(Date.parse(v)) ? v : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));

/** Resposta da RPC -> objeto da tela. Formato inesperado ou erro -> null (a tela mostra "tente de novo"). */
export function parseSubscription(data: unknown, error: unknown): Subscription | null {
  if (error || !data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!STATUSES.includes(d.status as Subscription["status"])) return null;
  const payments = Array.isArray(d.payments)
    ? (d.payments as Record<string, unknown>[])
        .filter((p) => p && iso(p.at))
        .map((p) => ({ at: iso(p.at)!, status: String(p.status ?? "unknown"), amount: num(p.amount), refunded: num(p.refunded) ?? 0 }))
    : [];
  return {
    status: d.status as Subscription["status"],
    amount: num(d.amount),
    trialEndsAt: iso(d.trial_ends_at),
    nextPaymentAt: iso(d.next_payment_at),
    canceledAt: iso(d.canceled_at),
    access: parseAccess(d.access, null),
    canCancel: d.can_cancel === true,
    cancelPending: d.cancel_pending === true,
    payments,
  };
}

/** "08/12/2026" no fuso de Brasília. */
export function formatDayBR(value: string | null | undefined): string {
  if (!value || isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(value));
}

const money = (v: number | null) =>
  v === null ? null : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

export type SubTone = "ok" | "warn" | "off";
export type SubSummary = { title: string; tone: SubTone; lines: string[]; canSubscribe: boolean };

/** Título e frases do cartão principal, na voz da Sócia. */
export function describeSubscription(s: Subscription): SubSummary {
  const price = money(s.amount);
  const keep = "Seus dados continuam guardados.";
  // Cancelada, mas com mês pago valendo (0041): o acesso decide, não a situação no Mercado Pago.
  if (s.access.status === "ending" && s.access.until) {
    return {
      title: "Assinatura cancelada",
      tone: "warn",
      lines: [`Você continua usando a Sócia até ${formatDayBR(s.access.until)}. Não haverá novas cobranças.`, keep],
      canSubscribe: false,
    };
  }
  switch (s.status) {
    case "free":
      return { title: "Cortesia", tone: "ok", lines: ["Sua conta tem acesso liberado, sem cobrança."], canSubscribe: false };
    case "trialing":
      return {
        title: "Teste grátis",
        tone: "ok",
        lines: [
          s.trialEndsAt ? `O teste vai até ${formatDayBR(s.trialEndsAt)}. Nada é cobrado até lá.` : "Nada é cobrado durante o teste.",
          s.nextPaymentAt && price ? `Depois, ${price} por mês, a partir de ${formatDayBR(s.nextPaymentAt)}.` : "Depois, a cobrança é mensal.",
        ],
        canSubscribe: false,
      };
    case "active":
      return {
        title: "Assinatura ativa",
        tone: "ok",
        lines: [s.nextPaymentAt ? `Próxima cobrança${price ? ` de ${price}` : ""} em ${formatDayBR(s.nextPaymentAt)}.` : "Cobrança mensal no Mercado Pago."],
        canSubscribe: false,
      };
    case "past_due":
      return {
        title: "Pagamento não aprovado",
        tone: "warn",
        lines: ["O Mercado Pago não conseguiu fazer a última cobrança. Troque a forma de pagamento para não pausar o acesso."],
        canSubscribe: false,
      };
    case "pending":
      return { title: "Assinatura em análise", tone: "warn", lines: ["O Mercado Pago ainda está confirmando o pagamento."], canSubscribe: false };
    case "canceled":
      return { title: "Assinatura cancelada", tone: "off", lines: ["Para voltar a usar, é só assinar de novo com o mesmo e-mail.", keep], canSubscribe: true };
    default:
      return { title: "Sem assinatura", tone: "off", lines: ["Assine para usar a Sócia com o mesmo e-mail desta conta.", keep], canSubscribe: true };
  }
}

const PAYMENT_LABEL: Record<string, string> = {
  approved: "Paga", scheduled: "Agendada", rejected: "Recusada", refunded: "Reembolsada", charged_back: "Contestada",
  cancelled: "Cancelada", pending: "Em processamento", in_process: "Em processamento", authorized: "Em processamento",
};
export function paymentLabel(p: SubPayment): string {
  if (p.status === "approved" && p.refunded > 0 && p.amount !== null && p.refunded < p.amount) return "Paga, com reembolso parcial";
  return PAYMENT_LABEL[p.status] ?? "—";
}

/** Texto do aviso antes de cancelar: muda se ainda está no teste (acesso para na hora) ou se há mês pago. */
export function cancelWarning(s: Subscription): string {
  if (s.status === "trialing") {
    return "Você está no teste grátis: nada é cobrado, e o acesso é pausado assim que o Mercado Pago confirmar o cancelamento.";
  }
  return "Não haverá novas cobranças. Você continua usando a Sócia até o fim do mês que já foi pago.";
}

export const CANCEL_REASONS = [
  "Está caro para mim agora",
  "Não usei o suficiente",
  "Faltou alguma função",
  "Vou parar de atender",
  "Outro motivo",
] as const;

// Página do Mercado Pago onde a pessoa vê as próprias assinaturas e troca o cartão.
export const MP_SUBSCRIPTIONS_URL = "https://www.mercadopago.com.br/subscriptions";
