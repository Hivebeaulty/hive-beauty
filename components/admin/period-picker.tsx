// Seletor de período do painel (visão geral e financeiro): atalhos + período personalizado.
import Link from "next/link";
import { cn } from "@/lib/utils";
import { PERIOD_OPTIONS, businessYmd, type Period } from "@/lib/hive/admin";

const field = "rounded border border-ink-200 bg-surface px-2 py-1 text-ink-800";

export function PeriodPicker({ basePath, period, de, ate }: { basePath: string; period: Period; de?: string; ate?: string }) {
  const today = businessYmd(new Date());
  return (
    <div className="space-y-2">
      <nav aria-label="Período" className="flex flex-wrap gap-1">
        {PERIOD_OPTIONS.map((p) => (
          <Link
            key={p.key}
            href={`${basePath}?periodo=${p.key}`}
            aria-current={period.key === p.key ? "true" : undefined}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold",
              period.key === p.key
                ? "bg-primary text-primary-ink"
                : "bg-surface text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50 hover:text-ink-800"
            )}
          >
            {p.label}
          </Link>
        ))}
      </nav>
      <form action={basePath} className="flex flex-wrap items-center gap-2 text-sm text-ink-600">
        <input type="hidden" name="periodo" value="custom" />
        <label className="flex items-center gap-1.5">
          De
          <input type="date" name="de" max={today} defaultValue={de ?? ""} required className={field} />
        </label>
        <label className="flex items-center gap-1.5">
          até
          <input type="date" name="ate" max={today} defaultValue={ate ?? ""} required className={field} />
        </label>
        <button className="rounded px-2.5 py-1 font-semibold text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50">Ver período</button>
      </form>
    </div>
  );
}
