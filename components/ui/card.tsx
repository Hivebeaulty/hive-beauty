import { cn } from "@/lib/utils";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md";
  interactive?: boolean;
  /**
   * default: superfície branca com borda e sombra quentes.
   * sand:    superfície areia, para agrupar conteúdo secundário.
   * feature: painel em cacau profundo — UM por tela, onde está o foco (ex.: "Hoje").
   */
  tone?: "default" | "sand" | "feature";
}

// Superfície branca padrão sobre o fundo creme. Substitui
// "rounded-2xl bg-white p-4/5/6 shadow-sm" repetido em cada tela.
export function Card({ className, padding = "md", interactive, tone = "default", ...props }: CardProps) {
  return (
    <div
      className={cn(
        tone === "default" && "rounded-lg border border-ink-100 bg-surface shadow-card",
        tone === "sand" && "rounded-lg border border-sand-200 bg-sand",
        tone === "feature" && "rounded-xl border border-ink-800 bg-ink-800 text-cream shadow-feature",
        padding === "md" && "p-5",
        padding === "sm" && "p-3.5",
        interactive &&
          "transition-colors hover:border-ink-200 active:bg-ink-50",
        className
      )}
      {...props}
    />
  );
}
