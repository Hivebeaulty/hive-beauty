export const STATUS_LABEL: Record<string, string> = {
  agendado: "Agendado",
  confirmado: "Confirmado",
  em_atendimento: "Em atendimento",
  concluido: "Concluído",
  cancelado: "Cancelado",
  nao_compareceu: "Não compareceu",
};

// LEGADO — usado pelas telas ainda não migradas para <StatusBadge />.
// Remover quando a Etapa 2/5 terminar de migrar agenda e clientes.
export const STATUS_COLOR: Record<string, string> = {
  agendado: "bg-blush-200 text-charcoal-900",
  confirmado: "bg-plum-500 text-white",
  em_atendimento: "bg-warning text-white",
  concluido: "bg-success text-white",
  cancelado: "bg-charcoal-500 text-white",
  nao_compareceu: "bg-danger text-white",
};

// Novo mapeamento, consumido por <StatusBadge /> (components/ui/status-badge.tsx).
import type { BadgeTone } from "@/components/ui/badge";

export const STATUS_TONE: Record<string, BadgeTone> = {
  agendado: "neutral",
  confirmado: "gold",
  em_atendimento: "warning",
  concluido: "success",
  cancelado: "neutral",
  nao_compareceu: "danger",
};
