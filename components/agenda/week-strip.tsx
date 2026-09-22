"use client";

import { cn } from "@/lib/utils";
import { isSameDay } from "@/lib/hive/schedule";

export type WeekAppointment = {
  id: string;
  scheduled_start: string;
  status: string;
  clients: { name: string } | null;
};

const HIDDEN_STATUSES = ["cancelado", "nao_compareceu"];
const DOT_TONE: Record<string, string> = {
  agendado: "bg-ink-300",
  confirmado: "bg-gold-500",
  em_atendimento: "bg-warning",
  concluido: "bg-success",
};

const WEEKDAY_LABEL = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

export function WeekStrip({
  days,
  appointmentsByDay,
  onSelectDay,
}: {
  days: Date[];
  appointmentsByDay: Map<string, WeekAppointment[]>;
  onSelectDay: (d: Date) => void;
}) {
  const today = new Date();

  return (
    <div className="grid grid-cols-7 gap-1.5">
      {days.map((d, i) => {
        const key = d.toISOString().slice(0, 10);
        const dayAppts = (appointmentsByDay.get(key) ?? []).filter((a) => !HIDDEN_STATUSES.includes(a.status));
        const isToday = isSameDay(d, today);

        return (
          <div key={key} className="flex flex-col">
            <button
              onClick={() => onSelectDay(d)}
              className="mb-2 flex flex-col items-center gap-1 rounded-md py-1 transition-colors hover:bg-ink-50"
            >
              <span className="text-[10px] font-medium text-ink-400">{WEEKDAY_LABEL[i]}</span>
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                  isToday ? "bg-ink-800 text-cream" : "text-ink-700"
                )}
              >
                {d.getDate()}
              </span>
            </button>

            {/* Mobile: só pontinhos de status. Desktop: mini lista legível. */}
            <div className="flex justify-center gap-0.5 sm:hidden">
              {dayAppts.slice(0, 4).map((a) => (
                <span key={a.id} className={cn("size-1.5 rounded-full", DOT_TONE[a.status] ?? DOT_TONE.agendado)} />
              ))}
            </div>

            <div className="hidden space-y-1 sm:block">
              {dayAppts.slice(0, 3).map((a) => (
                <a
                  key={a.id}
                  href={`/agenda/${a.id}`}
                  className="block truncate rounded border-l-2 border-ink-300 bg-ink-50 px-1.5 py-1 text-[10.5px] font-medium text-ink-700 hover:bg-ink-100"
                >
                  {new Date(a.scheduled_start).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}{" "}
                  {a.clients?.name?.split(" ")[0]}
                </a>
              ))}
              {dayAppts.length > 3 && (
                <button onClick={() => onSelectDay(d)} className="text-[10.5px] font-medium text-ink-400 hover:text-ink-600">
                  +{dayAppts.length - 3} mais
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
