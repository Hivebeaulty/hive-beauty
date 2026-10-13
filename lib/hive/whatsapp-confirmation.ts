// WhatsApp (W5) — situação da CONFIRMAÇÃO AUTOMÁTICA de um agendamento.
// Lógica PURA: traduz a resposta de wa_get_appointment_confirmation (migration
// 0018) em texto e decide se a tela ainda oferece o envio manual (wa.me).
// Quem decide enviar, cancelar ou recusar é o banco; isto só descreve.
import type { Tone } from "./whatsapp";

export type ConfirmationState =
  | "none"
  | "skipped"
  | "queued"
  | "retrying"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "canceled";

const STATES: readonly ConfirmationState[] = [
  "none", "skipped", "queued", "retrying", "sending", "sent", "delivered", "read", "failed", "canceled",
];

export type Confirmation = { state: ConfirmationState; reason: string | null };

// Resposta inesperada (ou RPC ausente: 0018 não aplicada) → null = a tela segue
// exatamente como antes (só o envio manual).
export function parseConfirmation(data: unknown): Confirmation | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.state !== "string" || !STATES.includes(d.state as ConfirmationState)) return null;
  return { state: d.state as ConfirmationState, reason: typeof d.reason === "string" && d.reason ? d.reason : null };
}

export type ConfirmationView = {
  label: string;
  tone: Tone;
  detail: string | null;
  /** O sistema já cuida (ou cuidou) do envio: NÃO oferecer o wa.me (evita mensagem em dobro). */
  autoHandled: boolean;
  /** Pode oferecer o envio manual pelo celular. Falso quando a cliente pediu para sair. */
  allowManual: boolean;
};

const OPTED_OUT = new Set(["blocked", "recipient_blocked"]);

export function describeConfirmation(c: Confirmation | null): ConfirmationView | null {
  if (!c || c.state === "none") return null;
  const auto = (label: string, tone: Tone, detail: string | null): ConfirmationView => ({
    label, tone, detail, autoHandled: true, allowManual: false,
  });
  switch (c.state) {
    case "queued":
      return auto("Confirmação na fila", "gold", "Será enviada automaticamente pelo WhatsApp da empresa em instantes.");
    case "sending":
      return auto("Enviando confirmação", "gold", null);
    case "retrying":
      return auto("Enviando confirmação", "warning", "A primeira tentativa não foi concluída; o envio será repetido sozinho.");
    case "sent":
      return auto("Confirmação enviada", "success", "Enviada pelo WhatsApp da empresa.");
    case "delivered":
      return auto("Confirmação entregue", "success", "Entregue no WhatsApp da cliente.");
    case "read":
      return auto("Confirmação lida", "success", "A cliente leu a mensagem.");
    case "failed":
      return {
        label: "Confirmação não enviada",
        tone: "danger",
        detail: c.reason === "no_whatsapp" ? "Este número não tem WhatsApp." : "O envio automático falhou depois de várias tentativas.",
        autoHandled: false,
        allowManual: c.reason !== "no_whatsapp",
      };
    case "canceled":
      if (c.reason && OPTED_OUT.has(c.reason)) return optedOut();
      return {
        label: "Confirmação cancelada",
        tone: "neutral",
        detail: c.reason === "appointment_changed" ? "O agendamento mudou antes do envio." : null,
        autoHandled: false,
        allowManual: true,
      };
    case "skipped":
    default:
      return describeSkipped(c.reason);
  }
}

function optedOut(): ConfirmationView {
  return {
    label: "Cliente não recebe mensagens",
    tone: "neutral",
    detail: "Ela pediu para não receber mensagens desta empresa. Nenhuma confirmação é enviada.",
    autoHandled: false,
    allowManual: false,
  };
}

function describeSkipped(reason: string | null): ConfirmationView | null {
  if (reason && OPTED_OUT.has(reason)) return optedOut();
  const manual = (label: string, detail: string | null): ConfirmationView => ({
    label, tone: "neutral", detail, autoHandled: false, allowManual: true,
  });
  switch (reason) {
    case "not_connected":
      return manual("Não enviada automaticamente", "O WhatsApp da empresa não estava conectado.");
    case "disabled":
      return manual("Envio automático desligado", "A empresa desligou o envio automático.");
    case "rate_limited":
      return manual("Não enviada automaticamente", "Muitas mensagens em pouco tempo. Envie pelo celular, se quiser.");
    case "error":
      return manual("Não enviada automaticamente", null);
    // sem telefone / inválido / fixo / arquivada: a tela já explica pelo telefone cadastrado
    default:
      return null;
  }
}
