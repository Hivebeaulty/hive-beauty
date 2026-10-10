// Formas de pagamento — módulo puro (sem dependências), reexportado por finance.ts.
// 'cartao' (sem crédito/débito) é o valor ANTIGO: pagamentos históricos continuam
// válidos e aparecem como "Cartão". Para novos lançamentos usa-se crédito/débito.
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  pix: "Pix",
  dinheiro: "Dinheiro",
  cartao: "Cartão",
  cartao_credito: "Cartão de crédito",
  cartao_debito: "Cartão de débito",
  outro: "Outro",
};

// Forma padrão ao registrar um atendimento realizado.
export const DEFAULT_PAYMENT_METHOD = "pix";

export const SELECTABLE_PAYMENT_METHODS = ["pix", "dinheiro", "cartao_credito", "cartao_debito", "outro"] as const;

// Opções do <select>. Se o registro já tem o valor antigo 'cartao', ele é
// mantido na lista (senão o select mostraria outra forma, sem a usuária notar).
export function paymentMethodOptions(current?: string | null): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = SELECTABLE_PAYMENT_METHODS.map((value) => ({
    value,
    label: PAYMENT_METHOD_LABEL[value],
  }));
  if (current === "cartao") opts.splice(2, 0, { value: "cartao", label: "Cartão (antigo)" });
  return opts;
}
