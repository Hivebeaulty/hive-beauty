import { cn } from "@/lib/utils";

// Skeleton genérico — substitui "Carregando..." em texto puro.
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton-shimmer animate-shimmer rounded", className)} />;
}

// Atalho para a lista mais comum do app: linhas de card (agenda, clientes).
export function SkeletonListItem() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-100 p-4">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </div>
  );
}
