import { toSaoPauloDate } from "./period";

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  pix: "Pix",
  dinheiro: "Dinheiro",
  cartao: "Cartão",
  outro: "Outro",
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pago: "Pago",
  parcial: "Parcial",
  pendente: "Pendente",
};

// Mesma regra de "qual data representa essa despesa" usada dentro da RPC
// get_period_indicators (coalesce(paid_at, due_date, created_at)), agora com
// paid_at/created_at convertidos para o dia em Brasília (a RPC faz o mesmo
// com AT TIME ZONE desde a migration 0006). due_date já é uma data pura.
export function expenseEffectiveDate(e: { paid_at: string | null; due_date: string | null; created_at: string }) {
  if (e.paid_at) return toSaoPauloDate(e.paid_at);
  if (e.due_date) return e.due_date.slice(0, 10);
  return toSaoPauloDate(e.created_at);
}

export function isWithinPeriod(dateStr: string, start: string, end: string) {
  return dateStr >= start && dateStr <= end;
}
