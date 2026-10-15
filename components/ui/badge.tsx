import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "gold" | "wine" | "muted";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-ink-100 text-ink-700",
  primary: "bg-ink-800 text-cream",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  gold: "bg-gold-100 text-gold-700",
  wine: "bg-wine-50 text-wine-500",
  // "perdeu o efeito" (ex.: cancelado): só contorno, texto discreto
  muted: "bg-transparent text-ink-400 ring-1 ring-inset ring-ink-200",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

// Pílula de status genérica. Base do StatusBadge abaixo, mas também serve
// pra qualquer outro rótulo curto (plano, papel do usuário, etc.).
export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold leading-none",
        TONE_CLASSES[tone],
        className
      )}
      {...props}
    />
  );
}
