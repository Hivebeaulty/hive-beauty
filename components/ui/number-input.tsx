"use client";

import { useEffect, useState } from "react";
import { Input, type InputProps } from "./input";

export interface NumberInputProps extends Omit<InputProps, "value" | "onChange" | "type"> {
  value: number;
  onChange: (value: number) => void;
  /** true para minutos/quantidades (sem casas decimais). Padrão: aceita decimal (valor em R$). */
  integer?: boolean;
}

// Campo numérico "de verdade" pra digitar — resolve o problema clássico do
// <input type="number" value={0}>: apagar o "0" gera value="" -> Number("")
// = 0 -> o campo volta a mostrar "0" na hora, e a usuária nunca consegue
// limpar pra digitar um valor novo. Aqui o que fica na tela é texto livre
// (permite ficar vazio enquanto digita) e só convertemos pra número quando o
// texto já é um número válido — o "0" nunca é forçado de volta.
export function NumberInput({ value, onChange, integer = false, ...props }: NumberInputProps) {
  const [text, setText] = useState(value === 0 ? "" : String(value));

  // Sincroniza se o valor mudar de fora (ex.: trocar de serviço recalcula o
  // preço) — mas não enquanto a própria digitação já corresponde ao valor.
  useEffect(() => {
    const parsed = text === "" || text === "-" ? 0 : Number(text.replace(",", "."));
    if (parsed !== value) setText(value === 0 ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const pattern = integer ? /^\d*$/ : /^\d*[.,]?\d*$/;

  return (
    <Input
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw !== "" && !pattern.test(raw)) return;
        setText(raw);
        const normalized = raw.replace(",", ".");
        onChange(normalized === "" || normalized === "-" ? 0 : Number(normalized));
      }}
      onBlur={() => {
        // Sai do campo vazio -> mostra "0" de verdade, não fica em branco escondendo o valor real.
        if (text === "") setText("0");
      }}
      {...props}
    />
  );
}
