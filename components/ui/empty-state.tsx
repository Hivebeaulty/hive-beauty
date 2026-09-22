import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

// Substitui os blocos "rounded-2xl bg-white p-6 text-center shadow-sm"
// repetidos em clientes, agenda, financeiro etc.
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-ink-200 px-6 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-ink-50">
        <Icon className="size-5 text-ink-400" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink-800">{title}</p>
        {description && <p className="text-sm text-ink-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}
