-- ---------------------------------------------------------------------------
-- 0011 — Formas de pagamento: cartão de crédito e cartão de débito
--
-- O enum payment_method é compartilhado por payments.method,
-- appointments.payment_method e expenses.payment_method. Valores atuais:
-- pix, dinheiro, cartao, outro.
--
-- Só ADICIONA valores. 'cartao' é mantido: pagamentos históricos continuam
-- válidos e aparecem como "Cartão". Nenhum dado é alterado.
--
-- Fica sozinha neste arquivo de propósito: o Postgres não deixa USAR um valor
-- de enum na mesma transação em que ele foi criado. As funções que o usam
-- estão na 0012 (outra transação).
-- ---------------------------------------------------------------------------
alter type payment_method add value if not exists 'cartao_credito';
alter type payment_method add value if not exists 'cartao_debito';
