// Acesso por assinatura (0037). Lógica PURA: interpreta a resposta de
// get_company_access / get_my_access e escolhe o texto da tela /assinatura.
//
// Falha FECHADA: erro da consulta ou resposta fora do formato -> sem acesso.
// Mas o erro vira status próprio ("error"), para a tela não dizer "assinatura
// cancelada" a quem paga e só pegou uma instabilidade.
export const LANDING_URL = "https://aurea-hivebeauty.lovable.app";
export const CHECKOUT_URL = "https://mpago.la/2gCWhAH";
export const TERMS_URL = `${LANDING_URL}/termos`;
export const PRIVACY_URL = `${LANDING_URL}/privacidade`;

// "suspended" (0038): conta suspensa pela administração da Áurea; vence a assinatura.
// "ending" (0041): cancelada, mas com o mês já pago ainda valendo (acesso até "until").
export type AccessStatus = "free" | "trialing" | "active" | "past_due" | "pending" | "canceled" | "none" | "suspended" | "ending" | "error";
export type Access = { status: AccessStatus; allowed: boolean; warning: boolean; until?: string };

const KNOWN: AccessStatus[] = ["free", "trialing", "active", "past_due", "pending", "canceled", "none", "suspended", "ending"];
const ALLOWED: AccessStatus[] = ["free", "trialing", "active", "past_due", "ending"];

export function parseAccess(data: unknown, error: unknown): Access {
  if (error || !data || typeof data !== "object") return { status: "error", allowed: false, warning: false };
  const raw = (data as { status?: unknown }).status;
  const status = KNOWN.includes(raw as AccessStatus) ? (raw as AccessStatus) : "error";
  // "allowed" é recalculado aqui com a mesma regra do banco: as duas precisam concordar.
  const allowed = ALLOWED.includes(status) && (data as { allowed?: unknown }).allowed === true;
  const until = (data as { until?: unknown }).until;
  // "ending" sem data válida não libera: sem saber até quando, falha fechada.
  if (status === "ending" && (typeof until !== "string" || isNaN(Date.parse(until)))) {
    return { status: "canceled", allowed: false, warning: false };
  }
  return {
    status,
    allowed,
    warning: allowed && (status === "past_due" || status === "ending"),
    ...(status === "ending" ? { until: until as string } : {}),
  };
}

export type AccessCopy = { title: string; text: string; canSubscribe: boolean };

/** Texto da tela /assinatura. `isOwner`: só a dona assina; a equipe é orientada a falar com ela. */
export function accessCopy(status: AccessStatus, isOwner: boolean): AccessCopy {
  const keep = "Seus dados continuam guardados: nada foi apagado.";
  if (status === "suspended") {
    // Assinar de novo não resolve: quem libera é o suporte. Vale para dona e equipe.
    return {
      title: "Acesso suspenso",
      text: `O acesso a esta conta foi suspenso pela equipe da Áurea. Fale com o suporte para entender e reativar. ${keep}`,
      canSubscribe: false,
    };
  }
  if (status === "error") {
    return { title: "Não conseguimos conferir sua assinatura", text: "Tente de novo em alguns instantes.", canSubscribe: false };
  }
  if (!isOwner) {
    return {
      title: "Acesso pausado",
      text: `A assinatura deste negócio não está ativa. Fale com a dona da conta para liberar o acesso. ${keep}`,
      canSubscribe: false,
    };
  }
  if (status === "pending") {
    return {
      title: "Pagamento em análise",
      text: "O Mercado Pago ainda está confirmando sua assinatura. Assim que confirmar, o acesso é liberado sozinho.",
      canSubscribe: false,
    };
  }
  if (status === "canceled") {
    return { title: "Assinatura cancelada", text: `Assine de novo para voltar a usar a Áurea. ${keep}`, canSubscribe: true };
  }
  return { title: "Assine para usar a Áurea", text: `Sua conta ainda não tem uma assinatura ativa. ${keep}`, canSubscribe: true };
}

/** Data em que o acesso termina (assinatura cancelada com mês pago), no fuso do negócio. */
export function formatUntil(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
}
