import { cn } from "@/lib/utils";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md";
  interactive?: boolean;
}

// Superfície branca padrão sobre o fundo creme. Substitui
// "rounded-2xl bg-white p-4/5/6 shadow-sm" repetido em cada tela.
export function Card({ className, padding = "md", interactive, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-ink-100 bg-surface",
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
