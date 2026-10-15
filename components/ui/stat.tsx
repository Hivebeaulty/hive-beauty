import { cn } from "@/lib/utils";

export interface StatProps {
  value: React.ReactNode;
  label: string;
  /** Linha curta de contexto abaixo do rótulo (ex.: "nos próximos 7 dias"). */
  hint?: string;
  /** "lg" para o número principal de um painel; "md" padrão; "sm" para listas densas. */
  size?: "sm" | "md" | "lg";
  /** onDark: dentro do Card tone="feature" (cacau). */
  onDark?: boolean;
  /** Destaque do valor (ex.: dinheiro no painel em cacau). */
  accent?: boolean;
  /** Cor do valor quando ele carrega um sinal (ex.: atenção). */
  valueClassName?: string;
  className?: string;
}

// Indicador (valor + rótulo). Números com algarismos de mesma largura e que
// NUNCA invadem o vizinho: o valor pode quebrar de tamanho (classes por tela),
// mas não transborda (min-w-0 + whitespace-nowrap + leading justo).
export function Stat({ value, label, hint, size = "md", onDark, accent, valueClassName, className }: StatProps) {
  return (
    <div data-stat="" className={cn("min-w-0", className)}>
      <p
        className={cn(
          "whitespace-nowrap font-serif font-medium leading-none tabular-nums tracking-[-0.01em]",
          size === "lg" && "text-[2rem] sm:text-[2.25rem]",
          size === "md" && "text-[1.625rem]",
          size === "sm" && "text-xl",
          onDark ? (accent ? "text-gold-300" : "text-cream") : accent ? "text-gold-700" : "text-ink-800",
          valueClassName
        )}
      >
        {value}
      </p>
      <p className={cn("mt-1.5 text-xs font-medium", onDark ? "text-ink-100" : "text-ink-500")}>{label}</p>
      {hint && <p className={cn("text-[11px]", onDark ? "text-ink-200" : "text-ink-400")}>{hint}</p>}
    </div>
  );
}
