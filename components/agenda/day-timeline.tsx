"use client";

import Link from "next/link";
import type { Professional } from "@/lib/hive/schedule";
import { cn } from "@/lib/utils";
import { layoutOverlaps } from "@/components/agenda/week-view";
import { MARK_STEP_MIN, isFullHour, markLabel, timeMarks } from "@/lib/hive/timeline-marks";
import {
  appliesToLane,
  blockLabel,
  blockWhenText,
  blocksOnDay,
  clipToDay,
  type BlockedTime,
} from "@/lib/hive/blocked-times";
import { CalendarOff } from "lucide-react";

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
export const HIDDEN_STATUSES = ["cancelado", "nao_compareceu"];

// Cor por status — tons discretos, nada de saturação alta. Cada status usa a
// mesma lógica de tom do StatusBadge, só que como bloco preenchido.
export const BLOCK_TONE: Record<string, string> = {
  agendado: "bg-ink-50 border-ink-300 text-ink-700",
  confirmado: "bg-gold-50 border-gold-500 text-gold-700",
  em_atendimento: "bg-warning/10 border-warning text-warning",
  concluido: "bg-success/10 border-success text-success",
};

function minutesSinceMidnight(iso: string) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function computeRange(appts: TimelineAppointment[], extra: { startMin: number; endMin: number }[] = []) {
  let start = 8 * 60;
  let end = 20 * 60;
  for (const a of appts) {
    start = Math.min(start, Math.floor(minutesSinceMidnight(a.scheduled_start) / 60) * 60);
    end = Math.max(end, Math.ceil(minutesSinceMidnight(a.scheduled_end) / 60) * 60);
  }
  // bloqueios com horário (almoço, consulta) ampliam o dia se caírem fora do padrão
  for (const r of extra) {
    start = Math.min(start, Math.floor(r.startMin / 60) * 60);
    end = Math.max(end, Math.ceil(r.endMin / 60) * 60);
  }
  return { start, end };
}

export function DayTimeline({
  date,
  appointments,
  professionals,
  laneFilter,
  blocks = [],
}: {
  date: Date;
  appointments: TimelineAppointment[];
  professionals: Professional[];
  laneFilter: "all" | string;
  /** Bloqueios de horário (folga, almoço...) que podem tocar este dia. */
  blocks?: BlockedTime[];
}) {
  const visible = appointments.filter((a) => !HIDDEN_STATUSES.includes(a.status));
  const hidden = appointments.filter((a) => HIDDEN_STATUSES.includes(a.status));
  const dayBlocks = blocksOnDay(blocks, date);
  const blockRanges = dayBlocks
    .map((b) => clipToDay(b, date))
    .filter((c): c is { startMin: number; endMin: number } => !!c && c.startMin > 0 && c.endMin < 1440);
  const { start, end } = computeRange(visible, blockRanges);
  const totalMin = end - start;
  // Eixo de meia em meia hora (08:00, 08:30, 09:00...). O início e o fim do dia
  // continuam em hora cheia (computeRange), então a última marca é sempre :00.
  const marks = timeMarks(start, end);

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
          {/* Com mais de uma profissional cada coluna tem um título (h-4 + mb-1.5):
              o eixo ganha o mesmo espaço para os horários ficarem na linha certa. */}
          {effectiveLanes.length > 1 && <div className="mb-1.5 h-4" aria-hidden="true" />}
          {marks.map((m) => (
            <div key={m} style={{ height: MARK_STEP_MIN * PX_PER_MIN }} className="relative -top-2 text-[11px] text-ink-300">
              {markLabel(m)}
            </div>
          ))}
        </div>

        <div className="flex flex-1 gap-2">
          {effectiveLanes.map((lane) => {
            const laneAppts = lane ? visible.filter((a) => a.professional_member_id === lane.id) : visible;
            return (
              <div key={lane?.id ?? "__all__"} className="relative min-w-[168px] flex-1">
                {effectiveLanes.length > 1 && (
                  <p className="mb-1.5 h-4 truncate text-xs font-semibold text-ink-500">{lane?.name}</p>
                )}
                <div
                  className="relative rounded-md bg-ink-50/40"
                  style={{ height: totalMin * PX_PER_MIN }}
                >
                  {marks.map((m) => (
                    <div
                      key={m}
                      className={cn("absolute inset-x-0 border-t", isFullHour(m) ? "border-ink-100" : "border-ink-100/50")}
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

                  {/* Bloqueios (folga, almoço...): por baixo dos atendimentos, com a observação escrita. */}
                  {dayBlocks
                    .filter((b) => appliesToLane(b, lane?.id ?? null))
                    .map((b) => {
                      const c = clipToDay(b, date);
                      if (!c) return null;
                      const from = Math.max(c.startMin, start);
                      const to = Math.min(c.endMin, end);
                      if (to <= from) return null;
                      const height = (to - from) * PX_PER_MIN;
                      return (
                        <Link
                          key={b.id}
                          href={`/agenda/bloquear/${b.id}`}
                          data-testid="agenda-block"
                          title={`${blockLabel(b)} · ${blockWhenText(b)}`}
                          className="absolute inset-x-0.5 overflow-hidden rounded-md border-l-2 border-ink-400 bg-ink-100/80 px-2 py-1 text-left text-ink-600 transition-opacity hover:opacity-80"
                          style={{
                            top: (from - start) * PX_PER_MIN,
                            height,
                            backgroundImage:
                              "repeating-linear-gradient(135deg, transparent 0 6px, rgb(var(--c-ink-300) / 0.28) 6px 7px)",
                          }}
                        >
                          <p className="flex items-center gap-1 text-xs font-semibold leading-tight">
                            <CalendarOff className="size-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{blockLabel(b)}</span>
                          </p>
                          {height > 34 && <p className="truncate text-[11px] leading-tight opacity-80">{blockWhenText(b)}</p>}
                        </Link>
                      );
                    })}

                  {layoutOverlaps(laneAppts).map(({ a, lane: col, lanes: cols }) => {
                    const top = (minutesSinceMidnight(a.scheduled_start) - start) * PX_PER_MIN;
                    const height = Math.max(
                      (minutesSinceMidnight(a.scheduled_end) - minutesSinceMidnight(a.scheduled_start)) * PX_PER_MIN,
                      28
                    );
                    // Mais de uma cliente no mesmo horário (0053): ficam lado a lado, cada uma na sua faixa.
                    const side = cols > 1;
                    const width = 100 / cols;
                    return (
                      <Link
                        key={a.id}
                        href={`/agenda/${a.id}`}
                        title={side ? "Mesmo horário que outra cliente" : undefined}
                        className={cn(
                          "absolute overflow-hidden rounded-md border-l-2 px-2 py-1 text-left transition-opacity hover:opacity-80",
                          side ? "px-1.5" : "inset-x-0.5",
                          BLOCK_TONE[a.status] ?? BLOCK_TONE.agendado
                        )}
                        style={side ? { top, height, left: `calc(${col * width}% + 2px)`, width: `calc(${width}% - 4px)` } : { top, height }}
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

      {dayBlocks.length > 0 && (
        <div className="mt-3 space-y-1.5" data-testid="agenda-block-list">
          {dayBlocks.map((b) => {
            const who =
              professionals.length > 1
                ? ` · ${b.professional_member_id ? professionals.find((p) => p.id === b.professional_member_id)?.name ?? "Profissional" : "Toda a equipe"}`
                : "";
            return (
              <Link
                key={b.id}
                href={`/agenda/bloquear/${b.id}`}
                className="flex items-start gap-2.5 rounded-lg border border-ink-100 bg-ink-50/60 px-3 py-2 transition-colors hover:bg-ink-50"
              >
                <CalendarOff className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium text-ink-700">{blockLabel(b)}</span>
                  <span className="block text-xs text-ink-400">
                    {blockWhenText(b)}
                    {who}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      )}

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
