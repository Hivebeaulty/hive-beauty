// Acesso por assinatura (0037). Lógica PURA: interpreta a resposta de
// get_company_access / get_my_access e escolhe o texto da tela /assinatura.
//
// Falha FECHADA: erro da consulta ou resposta fora do formato -> sem acesso.
// Mas o erro vira status próprio ("error"), para a tela não dizer "assinatura
// cancelada" a quem paga e só pegou uma instabilidade.
export const LANDING_URL = "https://aurea-hivebeauty.lovable.app";
export const CHECKOUT_URL = "https://mpago.la/2gCWhAH";

// "suspended" (0038): conta suspensa pela administração da Áurea; vence a assinatura.
export type AccessStatus = "free" | "trialing" | "active" | "past_due" | "pending" | "canceled" | "none" | "suspended" | "error";
export type Access = { status: AccessStatus; allowed: boolean; warning: boolean };

const KNOWN: AccessStatus[] = ["free", "trialing", "active", "past_due", "pending", "canceled", "none", "suspended"];
const ALLOWED: AccessStatus[] = ["free", "trialing", "active", "past_due"];

export function parseAccess(data: unknown, error: unknown): Access {
  if (error || !data || typeof data !== "object") return { status: "error", allowed: false, warning: false };
  const raw = (data as { status?: unknown }).status;
  const status = KNOWN.includes(raw as AccessStatus) ? (raw as AccessStatus) : "error";
  // "allowed" é recalculado aqui com a mesma regra do banco: as duas precisam concordar.
  const allowed = ALLOWED.includes(status) && (data as { allowed?: unknown }).allowed === true;
  return { status, allowed, warning: allowed && status === "past_due" };
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
