import type { LucideIcon } from "lucide-react";
import { LineIllustration, OfficialIllustration, type IllustrationKind } from "@/components/ui/line-illustration";

export interface EmptyStateProps {
  icon: LucideIcon;
  /** Ilustração em traço fino da marca no lugar do ícone (uma por tela). */
  art?: boolean | IllustrationKind;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

// Substitui os blocos "rounded-2xl bg-white p-6 text-center shadow-sm"
// repetidos em clientes, agenda, financeiro etc.
export function EmptyState({ icon: Icon, title, description, action, art }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-ink-200 px-6 py-10 text-center">
      {art ? (
        art === true || art === "oficial" || art === "perfil" || art === "pensativa" ? (
          <OfficialIllustration className="animate-rise" />
        ) : (
          <LineIllustration kind={art} className="h-28 animate-rise" />
        )
      ) : (
        <div className="flex size-11 items-center justify-center rounded-full bg-sand ring-1 ring-sand-200">
          <Icon className="size-5 text-gold-700" aria-hidden="true" />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink-800">{title}</p>
        {description && <p className="text-sm text-ink-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}
