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
// get_period_indicators (coalesce(paid_at, due_date, created_at)) — replicada
// aqui em JS porque filtrar um coalesce de 3 colunas via query builder do
// Supabase não é direto. Sem isso, despesa sem due_date nunca aparecia em
// nenhum período (bug da versão anterior da tela).
export function expenseEffectiveDate(e: { paid_at: string | null; due_date: string | null; created_at: string }) {
  return (e.paid_at ?? e.due_date ?? e.created_at).slice(0, 10);
}

export function isWithinPeriod(dateStr: string, start: string, end: string) {
  return dateStr >= start && dateStr <= end;
}
