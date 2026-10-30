// Selo de status do painel: texto em ink-800 sobre ink-50 (12:1 no claro, 11,3:1 no
// Escuro) + bolinha na cor do status (contraste de elemento gráfico >= 3:1 nos dois
// temas, ver scripts/contrast-check.py). O Badge do app tem tons abaixo de 4,5:1 em
// um dos temas; o painel usa este para não depender da cor do texto.
import { cn } from "@/lib/utils";
import type { BadgeTone } from "@/components/ui/badge";

const DOT: Record<BadgeTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  gold: "bg-gold-700",
  wine: "bg-wine-500",
  neutral: "bg-ink-500",
  primary: "bg-ink-800",
  muted: "bg-ink-400",
};

export function StatusPill({ tone = "neutral", children, className }: { tone?: BadgeTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-ink-50 px-2.5 py-0.5 text-xs font-semibold text-ink-800 ring-1 ring-inset ring-ink-100", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      {children}
    </span>
  );
}
