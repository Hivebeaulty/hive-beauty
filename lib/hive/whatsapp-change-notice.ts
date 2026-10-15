// WhatsApp — situação do AVISO de remarcação/cancelamento (migration 0023).
// Lógica PURA: traduz wa_get_change_notice em uma frase para quem editou ou
// cancelou. Quem decide enviar é o banco; isto só descreve. Resposta ausente
// (migration não aplicada), de outro tipo ou sem aviso => null (nada aparece).

export type ChangeKind = "reschedule" | "cancel";
export type ChangeNotice = { kind: ChangeKind | null; state: string; reason: string | null };
export type ChangeNoticeView = { text: string };

const STATES = ["none", "skipped", "queued", "retrying", "sending", "sent", "delivered", "read", "failed", "canceled"];

export function parseChangeNotice(data: unknown): ChangeNotice | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.state !== "string" || !STATES.includes(d.state)) return null;
  const kind = d.kind === "reschedule" || d.kind === "cancel" ? d.kind : null;
  return { kind, state: d.state, reason: typeof d.reason === "string" && d.reason ? d.reason : null };
}

const NO_MOBILE = new Set(["no_phone", "invalid_phone", "landline", "archived", "no_client"]);

export function describeChangeNotice(n: ChangeNotice | null, expected: ChangeKind): ChangeNoticeView | null {
  if (!n || n.state === "none" || n.kind !== expected) return null;
  const what = expected === "cancel" ? "o cancelamento" : "o novo horário";
  switch (n.state) {
    case "queued":
    case "sending":
    case "retrying":
      return { text: `A cliente será avisada pelo WhatsApp sobre ${what}.` };
    case "sent":
    case "delivered":
    case "read":
      return { text: `A cliente foi avisada pelo WhatsApp sobre ${what}.` };
    case "failed":
      return { text: "O aviso pelo WhatsApp não pôde ser enviado. Avise a cliente por outro meio, se precisar." };
    case "canceled":
      return null; // substituído por uma mudança posterior
    case "skipped":
    default:
      if (n.reason === "confirmation_pending") {
        return {
          text: expected === "cancel"
            ? "A confirmação ainda não tinha saído, então nenhuma mensagem será enviada."
            : "A confirmação ainda não tinha saído: ela vai com o horário novo.",
        };
      }
      if (n.reason === "blocked") return { text: "A cliente pediu para não receber mensagens: nenhum aviso foi enviado." };
      if (n.reason === "not_connected") return { text: "O WhatsApp da empresa está desconectado. Avise a cliente, se precisar." };
      if (n.reason === "disabled") return { text: "As mensagens automáticas estão desligadas para a empresa." };
      if (n.reason && NO_MOBILE.has(n.reason)) {
        return { text: "A cliente não tem celular válido para WhatsApp. Avise por outro meio, se precisar." };
      }
      return { text: "Não foi possível agendar o aviso pelo WhatsApp. Avise a cliente, se precisar." };
  }
}
