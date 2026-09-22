"use client";

import { cn } from "@/lib/utils";
import { isSameDay, isSameMonth } from "@/lib/hive/schedule";

const WEEKDAY_LABEL = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

export function MonthGrid({
  days,
  reference,
  countByDay,
  onSelectDay,
}: {
  days: Date[];
  reference: Date;
  countByDay: Map<string, { total: number; hasPending: boolean }>;
  onSelectDay: (d: Date) => void;
}) {
  const today = new Date();

  return (
    <div>
      <div className="mb-2 grid grid-cols-7">
        {WEEKDAY_LABEL.map((w) => (
          <div key={w} className="text-center text-[11px] font-medium text-ink-400">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {days.map((d) => {
          const key = d.toISOString().slice(0, 10);
          const info = countByDay.get(key);
          const inMonth = isSameMonth(d, reference);
          const isToday = isSameDay(d, today);

          return (
            <button
              key={key}
              onClick={() => onSelectDay(d)}
              className="flex flex-col items-center gap-1 rounded-md py-1.5 transition-colors hover:bg-ink-50"
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-[13px] font-medium",
                  isToday ? "bg-ink-800 text-cream" : inMonth ? "text-ink-800" : "text-ink-300"
                )}
              >
                {d.getDate()}
              </span>
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  info && info.total > 0 ? (info.hasPending ? "bg-gold-500" : "bg-ink-300") : "bg-transparent"
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
