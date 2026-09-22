"use client";

import Link from "next/link";
import type { Professional } from "@/lib/hive/schedule";
import { cn } from "@/lib/utils";

export type TimelineAppointment = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  professional_member_id: string;
  clients: { name: string } | null;
  services: { name: string } | null;
};

const PX_PER_MIN = 1.15;
const HIDDEN_STATUSES = ["cancelado", "nao_compareceu"];

// Cor por status — tons discretos, nada de saturação alta. Cada status usa a
// mesma lógica de tom do StatusBadge, só que como bloco preenchido.
const BLOCK_TONE: Record<string, string> = {
  agendado: "bg-ink-50 border-ink-300 text-ink-700",
  confirmado: "bg-gold-50 border-gold-500 text-gold-700",
  em_atendimento: "bg-warning/10 border-warning text-warning",
  concluido: "bg-success/10 border-success text-success",
};

function minutesSinceMidnight(iso: string) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function computeRange(appts: TimelineAppointment[]) {
  let start = 8 * 60;
  let end = 20 * 60;
  for (const a of appts) {
    start = Math.min(start, Math.floor(minutesSinceMidnight(a.scheduled_start) / 60) * 60);
    end = Math.max(end, Math.ceil(minutesSinceMidnight(a.scheduled_end) / 60) * 60);
  }
  return { start, end };
}

export function DayTimeline({
  date,
  appointments,
  professionals,
  laneFilter,
}: {
  date: Date;
  appointments: TimelineAppointment[];
  professionals: Professional[];
  laneFilter: "all" | string;
}) {
  const visible = appointments.filter((a) => !HIDDEN_STATUSES.includes(a.status));
  const hidden = appointments.filter((a) => HIDDEN_STATUSES.includes(a.status));
  const { start, end } = computeRange(visible);
  const totalMin = end - start;
  const hourMarks = Array.from({ length: Math.floor(totalMin / 60) + 1 }, (_, i) => start + i * 60);

  const lanes: Professional[] =
    laneFilter === "all" && professionals.length > 1
      ? professionals
      : professionals.filter((p) => p.id === (laneFilter === "all" ? professionals[0]?.id : laneFilter));
  // Lista de profissionais ainda não carregou (ou veio vazia por algum
  // motivo) — não deixa os atendimentos somem, mostra tudo numa lane só.
  const effectiveLanes: (Professional | null)[] = lanes.length > 0 ? lanes : [null];

  const isToday = (() => {
    const now = new Date();
    return now.toDateString() === date.toDateString();
  })();
  const nowMin = minutesSinceMidnight(new Date().toISOString());

  return (
    <div>
      <div className="flex overflow-x-auto">
        {/* Eixo de horas — uma vez só, compartilhado por todas as lanes */}
        <div className="w-12 shrink-0 select-none pr-2 text-right">
          {hourMarks.map((m) => (
            <div key={m} style={{ height: 60 * PX_PER_MIN }} className="relative -top-2 text-[11px] text-ink-300">
              {String(Math.floor(m / 60)).padStart(2, "0")}:00
            </div>
          ))}
        </div>

        <div className="flex flex-1 gap-2">
          {effectiveLanes.map((lane) => {
            const laneAppts = lane ? visible.filter((a) => a.professional_member_id === lane.id) : visible;
            return (
              <div key={lane?.id ?? "__all__"} className="relative min-w-[168px] flex-1">
                {effectiveLanes.length > 1 && (
                  <p className="mb-1.5 truncate text-xs font-semibold text-ink-500">{lane?.name}</p>
                )}
                <div
                  className="relative rounded-md bg-ink-50/40"
                  style={{ height: totalMin * PX_PER_MIN }}
                >
                  {hourMarks.map((m) => (
                    <div
                      key={m}
                      className="absolute inset-x-0 border-t border-ink-100"
                      style={{ top: (m - start) * PX_PER_MIN }}
                    />
                  ))}

                  {isToday && nowMin >= start && nowMin <= end && (
                    <div
                      className="absolute inset-x-0 z-10 flex items-center gap-1"
                      style={{ top: (nowMin - start) * PX_PER_MIN }}
                    >
                      <div className="h-1.5 w-1.5 rounded-full bg-danger" />
                      <div className="h-px flex-1 bg-danger/60" />
                    </div>
                  )}

                  {laneAppts.map((a) => {
                    const top = (minutesSinceMidnight(a.scheduled_start) - start) * PX_PER_MIN;
                    const height = Math.max(
                      (minutesSinceMidnight(a.scheduled_end) - minutesSinceMidnight(a.scheduled_start)) * PX_PER_MIN,
                      28
                    );
                    return (
                      <Link
                        key={a.id}
                        href={`/agenda/${a.id}`}
                        className={cn(
                          "absolute inset-x-0.5 overflow-hidden rounded-md border-l-2 px-2 py-1 text-left transition-opacity hover:opacity-80",
                          BLOCK_TONE[a.status] ?? BLOCK_TONE.agendado
                        )}
                        style={{ top, height }}
                      >
                        <p className="truncate text-xs font-semibold leading-tight">{a.clients?.name}</p>
                        {height > 34 && <p className="truncate text-[11px] leading-tight opacity-80">{a.services?.name}</p>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hidden.length > 0 && (
        <p className="mt-3 text-xs text-ink-300">
          {hidden.filter((h) => h.status === "cancelado").length > 0 &&
            `${hidden.filter((h) => h.status === "cancelado").length} cancelado(s)`}
          {hidden.some((h) => h.status === "cancelado") && hidden.some((h) => h.status === "nao_compareceu") && " · "}
          {hidden.filter((h) => h.status === "nao_compareceu").length > 0 &&
            `${hidden.filter((h) => h.status === "nao_compareceu").length} não compareceu`}
        </p>
      )}
    </div>
  );
}
