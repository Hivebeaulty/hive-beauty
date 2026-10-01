"use client";

import Link from "next/link";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { isSameDay, type Professional } from "@/lib/hive/schedule";
import { formatDuration } from "@/lib/hive/format";
import { StatusBadge } from "@/components/ui/status-badge";
import { BLOCK_TONE, HIDDEN_STATUSES } from "./day-timeline";
import { Plus } from "lucide-react";

export type WeekAppointment = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  professional_member_id: string;
  clients: { name: string } | null;
  services: { name: string } | null;
};

const PX_PER_MIN = 0.95;
const WEEKDAY_SHORT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const WEEKDAY_LONG = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

// Chave de dia SEMPRE no relógio local (mesmo relógio usado pra desenhar as
// horas). Antes usava scheduled_start.slice(0, 10), que é o dia em UTC — um
// atendimento às 22h caía no dia seguinte.
export const localDayKey = (d: Date | string) => format(new Date(d), "yyyy-MM-dd");

const minutesOfDay = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

// Atendimentos de profissionais diferentes podem se sobrepor no tempo (a
// exclusion constraint só impede sobreposição da MESMA profissional). Coloca
// os que se sobrepõem lado a lado, em faixas.
function layoutOverlaps(appts: WeekAppointment[]) {
  const sorted = [...appts].sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));
  const out: { a: WeekAppointment; lane: number; lanes: number }[] = [];
  let cluster: { a: WeekAppointment; lane: number; end: number }[] = [];
  let clusterEnd = -1;

  const flush = () => {
    const lanes = Math.max(...cluster.map((c) => c.lane)) + 1;
    cluster.forEach((c) => out.push({ a: c.a, lane: c.lane, lanes }));
    cluster = [];
    clusterEnd = -1;
  };

  for (const a of sorted) {
    const s = minutesOfDay(a.scheduled_start);
    const e = Math.max(minutesOfDay(a.scheduled_end), s + 15);
    if (cluster.length && s >= clusterEnd) flush();
    const laneEnds: number[] = [];
    cluster.forEach((c) => (laneEnds[c.lane] = Math.max(laneEnds[c.lane] ?? 0, c.end)));
    let lane = 0;
    while (laneEnds[lane] !== undefined && laneEnds[lane] > s) lane++;
    cluster.push({ a, lane, end: e });
    clusterEnd = Math.max(clusterEnd, e);
  }
  if (cluster.length) flush();
  return out;
}

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

const durationMin = (a: WeekAppointment) =>
  Math.round((new Date(a.scheduled_end).getTime() - new Date(a.scheduled_start).getTime()) / 60000);

export function WeekView({
  days,
  appointments,
  professionals,
  showProfessional,
  onSelectDay,
}: {
  days: Date[];
  appointments: WeekAppointment[];
  professionals: Professional[];
  showProfessional: boolean;
  onSelectDay: (d: Date) => void;
}) {
  const now = new Date();
  const profName = new Map(professionals.map((p) => [p.id, p.name.split(" ")[0]]));

  const visible = appointments.filter((a) => !HIDDEN_STATUSES.includes(a.status));
  const hiddenCount = appointments.length - visible.length;
  const byDay = new Map<string, WeekAppointment[]>();
  for (const a of visible) {
    const k = localDayKey(a.scheduled_start);
    byDay.set(k, [...(byDay.get(k) ?? []), a]);
  }

  // Faixa de horas da semana inteira (padrão 8h–20h, estende se preciso).
  let rangeStart = 8 * 60;
  let rangeEnd = 20 * 60;
  for (const a of visible) {
    rangeStart = Math.min(rangeStart, Math.floor(minutesOfDay(a.scheduled_start) / 60) * 60);
    rangeEnd = Math.max(rangeEnd, Math.ceil(minutesOfDay(a.scheduled_end) / 60) * 60);
  }
  const totalMin = rangeEnd - rangeStart;
  const hourMarks = Array.from({ length: Math.floor(totalMin / 60) + 1 }, (_, i) => rangeStart + i * 60);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <div>
      {/* ------------------------------------------------------------------
          DESKTOP: grade semanal de verdade — 7 colunas, eixo de horas,
          blocos posicionados por horário e duração.
          ------------------------------------------------------------------ */}
      <div className="hidden md:block">
        <div className="flex">
          <div className="w-11 shrink-0" />
          <div className="grid flex-1 grid-cols-7">
            {days.map((d, i) => {
              const isToday = isSameDay(d, now);
              const count = byDay.get(localDayKey(d))?.length ?? 0;
              return (
                <button
                  key={i}
                  onClick={() => onSelectDay(d)}
                  className="flex flex-col items-center gap-0.5 border-l border-ink-100 py-2 transition-colors hover:bg-ink-50"
                >
                  <span className="text-[11px] font-medium text-ink-400">{WEEKDAY_SHORT[i]}</span>
                  <span
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full text-sm font-semibold",
                      isToday ? "bg-ink-800 text-cream" : "text-ink-700"
                    )}
                  >
                    {d.getDate()}
                  </span>
                  <span className="text-[10px] text-ink-300">{count > 0 ? `${count} atend.` : "livre"}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex">
          <div className="w-11 shrink-0 select-none pr-2 text-right">
            {hourMarks.slice(0, -1).map((m) => (
              <div key={m} style={{ height: 60 * PX_PER_MIN }} className="relative -top-2 text-[10.5px] text-ink-300">
                {String(Math.floor(m / 60)).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-7">
            {days.map((d, i) => {
              const isToday = isSameDay(d, now);
              const placed = layoutOverlaps(byDay.get(localDayKey(d)) ?? []);
              return (
                <div
                  key={i}
                  className={cn("relative border-l border-ink-100", isToday && "bg-ink-50/60")}
                  style={{ height: totalMin * PX_PER_MIN }}
                >
                  {hourMarks.map((m) => (
                    <div
                      key={m}
                      className="absolute inset-x-0 border-t border-ink-100"
                      style={{ top: (m - rangeStart) * PX_PER_MIN }}
                    />
                  ))}

                  {isToday && nowMin >= rangeStart && nowMin <= rangeEnd && (
                    <div
                      className="absolute inset-x-0 z-10 flex items-center"
                      style={{ top: (nowMin - rangeStart) * PX_PER_MIN }}
                    >
                      <div className="size-1.5 rounded-full bg-danger" />
                      <div className="h-px flex-1 bg-danger/60" />
                    </div>
                  )}

                  {placed.map(({ a, lane, lanes }) => {
                    const top = (minutesOfDay(a.scheduled_start) - rangeStart) * PX_PER_MIN;
                    const height = Math.max(durationMin(a) * PX_PER_MIN, 22);
                    const width = 100 / lanes;
                    return (
                      <Link
                        key={a.id}
                        href={`/agenda/${a.id}`}
                        title={`${a.clients?.name ?? ""} · ${a.services?.name ?? ""} · ${timeLabel(a.scheduled_start)}–${timeLabel(a.scheduled_end)} (${formatDuration(durationMin(a))})${
                          showProfessional ? ` · ${profName.get(a.professional_member_id) ?? ""}` : ""
                        }`}
                        className={cn(
                          "absolute overflow-hidden rounded border-l-2 px-1.5 py-0.5 text-left transition-opacity hover:opacity-80",
                          BLOCK_TONE[a.status] ?? BLOCK_TONE.agendado
                        )}
                        style={{ top, height, left: `calc(${lane * width}% + 1px)`, width: `calc(${width}% - 2px)` }}
                      >
                        <p className="truncate text-[11px] font-semibold leading-tight">{a.clients?.name}</p>
                        {height > 30 && (
                          <p className="truncate text-[10px] leading-tight opacity-80">
                            {timeLabel(a.scheduled_start)}
                            {showProfessional && ` · ${profName.get(a.professional_member_id) ?? ""}`}
                          </p>
                        )}
                        {height > 44 && <p className="truncate text-[10px] leading-tight opacity-70">{a.services?.name}</p>}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------
          MOBILE: agenda em lista — os 7 dias, um abaixo do outro, com todos
          os detalhes. Sete colunas espremidas num celular não são legíveis;
          rolagem vertical é o gesto natural.
          ------------------------------------------------------------------ */}
      <div className="space-y-5 md:hidden">
        {days.map((d, i) => {
          const isToday = isSameDay(d, now);
          const list = [...(byDay.get(localDayKey(d)) ?? [])].sort((a, b) =>
            a.scheduled_start.localeCompare(b.scheduled_start)
          );
          const nowIndex = isToday ? list.findIndex((a) => new Date(a.scheduled_start) > now) : -1;
          const nowDivider = (
            <div className="flex items-center gap-1.5 py-1" aria-label="Agora">
              <div className="size-1.5 rounded-full bg-danger" />
              <div className="h-px flex-1 bg-danger/50" />
              <span className="text-[10px] font-medium text-danger">
                agora {now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          );

          return (
            <section key={i}>
              <button
                onClick={() => onSelectDay(d)}
                className="mb-2 flex w-full items-center justify-between text-left"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full text-sm font-semibold",
                      isToday ? "bg-ink-800 text-cream" : "bg-ink-50 text-ink-700"
                    )}
                  >
                    {d.getDate()}
                  </span>
                  <span className="text-sm font-semibold text-ink-800">
                    {WEEKDAY_LONG[i]}
                    {isToday && <span className="ml-1.5 text-xs font-medium text-gold-700">hoje</span>}
                  </span>
                </span>
                <span className="text-xs text-ink-400">
                  {list.length > 0 ? `${list.length} atendimento${list.length > 1 ? "s" : ""}` : ""}
                </span>
              </button>

              {list.length === 0 ? (
                <div className="flex items-center justify-between rounded-lg border border-dashed border-ink-200 px-3 py-2.5">
                  <span className="text-sm text-ink-300">Sem atendimentos</span>
                  <Link
                    href={`/agenda/novo?data=${format(d, "yyyy-MM-dd")}`}
                    className="flex items-center gap-1 text-xs font-semibold text-ink-500 hover:text-ink-800"
                  >
                    <Plus className="size-3.5" />
                    Agendar
                  </Link>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {list.map((a, idx) => (
                    <div key={a.id}>
                      {isToday && idx === nowIndex && nowDivider}
                      <Link
                        href={`/agenda/${a.id}`}
                        className="flex items-center gap-3 rounded-lg border border-ink-100 bg-surface px-3 py-2.5 transition-colors active:bg-ink-50"
                      >
                        <div className="w-12 shrink-0">
                          <p className="text-sm font-semibold text-ink-800">{timeLabel(a.scheduled_start)}</p>
                          <p className="text-[11px] text-ink-400">{formatDuration(durationMin(a))}</p>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink-800">{a.clients?.name}</p>
                          <p className="truncate text-xs text-ink-400">
                            {a.services?.name}
                            {showProfessional && profName.get(a.professional_member_id) && ` · ${profName.get(a.professional_member_id)}`}
                          </p>
                        </div>
                        <StatusBadge status={a.status} />
                      </Link>
                    </div>
                  ))}
                  {isToday && nowIndex === -1 && list.length > 0 && nowDivider}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {hiddenCount > 0 && (
        <p className="mt-3 text-xs text-ink-300">
          {hiddenCount} cancelado(s) ou falta(s) nesta semana não aparecem na grade.
        </p>
      )}
    </div>
  );
}
