export const STATUS_LABEL: Record<string, string> = {
  agendado: "Agendado",
  confirmado: "Confirmado",
  em_atendimento: "Em atendimento",
  concluido: "Concluído",
  cancelado: "Cancelado",
  nao_compareceu: "Não compareceu",
};

export const STATUS_COLOR: Record<string, string> = {
  agendado: "bg-blush-200 text-charcoal-900",
  confirmado: "bg-plum-500 text-white",
  em_atendimento: "bg-warning text-white",
  concluido: "bg-success text-white",
  cancelado: "bg-charcoal-500 text-white",
  nao_compareceu: "bg-danger text-white",
};
