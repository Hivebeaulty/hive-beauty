"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { addDays, addWeeks, addMonths, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import {
  getActiveProfessionals,
  getWeekDays,
  getMonthGrid,
  isSameDay,
  type Professional,
} from "@/lib/hive/schedule";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DayTimeline, type TimelineAppointment } from "@/components/agenda/day-timeline";
import { WeekStrip, type WeekAppointment } from "@/components/agenda/week-strip";
import { MonthGrid } from "@/components/agenda/month-grid";
import { CalendarPlus, ChevronLeft, ChevronRight, ChevronDown, CalendarX } from "lucide-react";

type View = "dia" | "semana" | "mes";

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function weekRangeLabel(start: Date, end: Date) {
  if (start.getMonth() === end.getMonth()) {
    return `${format(start, "d")}–${format(end, "d 'de' MMMM", { locale: ptBR })}`;
  }
  return `${format(start, "d 'de' MMM", { locale: ptBR })} – ${format(end, "d 'de' MMM", { locale: ptBR })}`;
}

export default function AgendaPage() {
  const { companyId } = useCompany();

  const [view, setView] = useState<View>("dia");
  const [refDate, setRefDate] = useState(() => startOfDay(new Date()));
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [selectedProfessional, setSelectedProfessional] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const [dayAppointments, setDayAppointments] = useState<TimelineAppointment[]>([]);
  const [weekByDay, setWeekByDay] = useState<Map<string, WeekAppointment[]>>(new Map());
  const [monthByDay, setMonthByDay] = useState<Map<string, { total: number; hasPending: boolean }>>(new Map());

  // Profissionais ativas — carregado uma vez. Se só houver uma, o filtro
  // nem aparece (não cria complexidade desnecessária pra quem trabalha sozinha).
  useEffect(() => {
    getActiveProfessionals(createClient(), companyId).then(setProfessionals);
  }, [companyId]);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();

    if (view === "dia") {
      let query = supabase
        .from("appointments")
        .select("id, scheduled_start, scheduled_end, status, professional_member_id, clients(name), services(name)")
        .eq("company_id", companyId)
        .gte("scheduled_start", refDate.toISOString())
        .lt("scheduled_start", addDays(refDate, 1).toISOString());
      if (selectedProfessional !== "all") query = query.eq("professional_member_id", selectedProfessional);
      const { data } = await query;
      setDayAppointments((data as unknown as TimelineAppointment[]) ?? []);
    }

    if (view === "semana") {
      const days = getWeekDays(refDate);
      let query = supabase
        .from("appointments")
        .select("id, scheduled_start, status, clients(name)")
        .eq("company_id", companyId)
        .gte("scheduled_start", days[0].toISOString())
        .lt("scheduled_start", addDays(days[6], 1).toISOString())
        .order("scheduled_start");
      if (selectedProfessional !== "all") query = query.eq("professional_member_id", selectedProfessional);
      const { data } = await query;
      const map = new Map<string, WeekAppointment[]>();
      for (const a of (data as unknown as (WeekAppointment & { scheduled_start: string })[]) ?? []) {
        const key = a.scheduled_start.slice(0, 10);
        map.set(key, [...(map.get(key) ?? []), a]);
      }
      setWeekByDay(map);
    }

    if (view === "mes") {
      const days = getMonthGrid(refDate);
      let query = supabase
        .from("appointments")
        .select("id, scheduled_start, status")
        .eq("company_id", companyId)
        .gte("scheduled_start", days[0].toISOString())
        .lt("scheduled_start", addDays(days[41], 1).toISOString());
      if (selectedProfessional !== "all") query = query.eq("professional_member_id", selectedProfessional);
      const { data } = await query;
      const map = new Map<string, { total: number; hasPending: boolean }>();
      for (const a of (data as { scheduled_start: string; status: string }[]) ?? []) {
        if (a.status === "cancelado" || a.status === "nao_compareceu") continue;
        const key = a.scheduled_start.slice(0, 10);
        const cur = map.get(key) ?? { total: 0, hasPending: false };
        cur.total += 1;
        if (a.status === "agendado") cur.hasPending = true;
        map.set(key, cur);
      }
      setMonthByDay(map);
    }

    setLoading(false);
  }, [companyId, view, refDate, selectedProfessional]);

  useEffect(() => {
    load();
  }, [load]);

  const weekDays = useMemo(() => getWeekDays(refDate), [refDate]);
  const monthDays = useMemo(() => getMonthGrid(refDate), [refDate]);
  const activeDayAppointments = dayAppointments.filter((a) => a.status !== "cancelado" && a.status !== "nao_compareceu");

  function goPrev() {
    setRefDate((d) => (view === "dia" ? addDays(d, -1) : view === "semana" ? addWeeks(d, -1) : addMonths(d, -1)));
  }
  function goNext() {
    setRefDate((d) => (view === "dia" ? addDays(d, 1) : view === "semana" ? addWeeks(d, 1) : addMonths(d, 1)));
  }
  function goToday() {
    setRefDate(startOfDay(new Date()));
  }
  function selectDay(d: Date) {
    setRefDate(startOfDay(d));
    setView("dia");
  }

  const label =
    view === "dia"
      ? refDate.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })
      : view === "semana"
        ? weekRangeLabel(weekDays[0], weekDays[6])
        : refDate.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Agenda</h1>
        <Link href={`/agenda/novo?data=${format(refDate, "yyyy-MM-dd")}`}>
          <Button size="sm">
            <CalendarPlus className="size-4" />
            <span className="hidden sm:inline">Novo atendimento</span>
            <span className="sm:hidden">Novo</span>
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          value={view}
          onChange={setView}
          options={[
            { value: "dia", label: "Dia" },
            { value: "semana", label: "Semana" },
            { value: "mes", label: "Mês" },
          ]}
        />
        {professionals.length > 1 && (
          <div className="relative">
            <select
              value={selectedProfessional}
              onChange={(e) => setSelectedProfessional(e.target.value)}
              className="appearance-none rounded-md border border-ink-200 bg-surface py-1.5 pl-3 pr-8 text-sm font-medium text-ink-700 outline-none focus:border-ink-800"
            >
              <option value="all">Todas</option>
              {professionals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-400" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            onClick={goPrev}
            aria-label="Anterior"
            className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-50 hover:text-ink-800"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            onClick={goNext}
            aria-label="Próximo"
            className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-ink-50 hover:text-ink-800"
          >
            <ChevronRight className="size-4" />
          </button>
          <span className="ml-1 text-sm font-medium capitalize text-ink-700">{label}</span>
        </div>
        {!isSameDay(refDate, new Date()) && (
          <button onClick={goToday} className="text-xs font-semibold text-ink-500 hover:text-ink-800">
            Hoje
          </button>
        )}
      </div>

      <Card>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        ) : view === "dia" ? (
          activeDayAppointments.length === 0 ? (
            <EmptyState
              icon={CalendarX}
              title="Nenhum atendimento neste dia"
              description="Que tal aproveitar para organizar a agenda da semana?"
              action={
                <Link href={`/agenda/novo?data=${format(refDate, "yyyy-MM-dd")}`}>
                  <Button variant="secondary" size="sm">
                    Criar agendamento
                  </Button>
                </Link>
              }
            />
          ) : (
            <DayTimeline
              date={refDate}
              appointments={dayAppointments}
              professionals={professionals}
              laneFilter={selectedProfessional}
            />
          )
        ) : view === "semana" ? (
          <WeekStrip days={weekDays} appointmentsByDay={weekByDay} onSelectDay={selectDay} />
        ) : (
          <MonthGrid days={monthDays} reference={refDate} countByDay={monthByDay} onSelectDay={selectDay} />
        )}
      </Card>
    </div>
  );
}
