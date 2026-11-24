"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { addDays, addWeeks, addMonths, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import { readScreenCache, writeScreenCache } from "@/lib/hive/screen-cache";
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
import { WeekView, localDayKey, type WeekAppointment } from "@/components/agenda/week-view";
import { MonthGrid } from "@/components/agenda/month-grid";
import { FORECAST_STATUSES, agendaPeriod, forecastFor, type AgendaView, type Forecast, type ForecastRow } from "@/lib/hive/forecast";
import { formatMoney } from "@/lib/hive/format";
import { readAgendaState, writeAgendaSearch } from "@/lib/hive/agenda-url";
import { BLOCK_SELECT, allDayKeys, blocksOnDay, type BlockedTime } from "@/lib/hive/blocked-times";
import { CalendarOff, CalendarPlus, ChevronLeft, ChevronRight, ChevronDown, CalendarX } from "lucide-react";

type View = AgendaView;

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

// Chave da memória da Agenda: empresa, visão, dia de referência e profissional.
function agendaKey(companyId: string, view: View, refDate: Date, professional: string) {
  return `agenda:${companyId}:${view}:${refDate.toISOString()}:${professional}`;
}

export default function AgendaPage() {
  const { companyId, role } = useCompany();
  // Valores só para a administração do negócio, como no card do Início.
  const canSeeFinance = role === "owner" || role === "admin";

  // Visão, dia e profissional vêm da URL (?visao=&data=&prof=). É isso que faz o
  // "Voltar" de um atendimento devolver o dia que estava sendo consultado, e não hoje.
  // Sem parâmetros: Dia, hoje, todas. Lido só na montagem; depois a tela é quem manda.
  const searchParams = useSearchParams();
  const [initial] = useState(() => readAgendaState(searchParams, new Date()));
  const [view, setView] = useState<View>(initial.view);
  const [refDate, setRefDate] = useState(() => initial.date);
  // Fase 2 do desempenho: ao voltar para a Agenda, o dia de hoje aparece na hora
  // com o que já tinha e atualiza por trás.
  const [professionals, setProfessionals] = useState<Professional[]>(
    () => readScreenCache<Professional[]>(`agenda-prof:${companyId}`) ?? []
  );
  const [selectedProfessional, setSelectedProfessional] = useState<string>(initial.professional);
  // Só o Dia aparece "na hora" com o que já estava na memória; Semana e Mês carregam.
  const [loading, setLoading] = useState(
    () =>
      !(initial.view === "dia" &&
        readScreenCache(agendaKey(companyId, "dia", initial.date, initial.professional)))
  );

  const [dayAppointments, setDayAppointments] = useState<TimelineAppointment[]>(
    () =>
      (initial.view === "dia"
        ? readScreenCache<TimelineAppointment[]>(agendaKey(companyId, "dia", initial.date, initial.professional))
        : undefined) ?? []
  );
  const [weekAppointments, setWeekAppointments] = useState<WeekAppointment[]>([]);
  const [monthByDay, setMonthByDay] = useState<Map<string, { total: number; hasPending: boolean }>>(new Map());
  // Bloqueios de horário (folga, almoço...) que tocam o período exibido.
  const [blocks, setBlocks] = useState<BlockedTime[]>([]);
  // Previsão do período exibido: null = carregando; "erro" = consulta falhou.
  const [forecast, setForecast] = useState<Forecast | "erro" | null>(null);

  // Profissionais ativas — carregado uma vez. Se só houver uma, o filtro
  // nem aparece (não cria complexidade desnecessária pra quem trabalha sozinha).
  useEffect(() => {
    getActiveProfessionals(createClient(), companyId).then((list) => {
      setProfessionals(list);
      writeScreenCache(`agenda-prof:${companyId}`, list);
      // profissional da URL que não existe (mais) na empresa: volta para "Todas"
      setSelectedProfessional((cur) => (cur === "all" || list.some((p) => p.id === cur) ? cur : "all"));
    });
  }, [companyId]);

  // Espelha visão, dia e profissional na URL (sem recarregar nem empilhar histórico).
  // `null` no primeiro argumento deixa o Next manter o estado interno dele.
  useEffect(() => {
    const next = writeAgendaSearch(
      window.location.search,
      { view, date: refDate, professional: selectedProfessional },
      new Date()
    );
    if (next === window.location.search) return;
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${next}${window.location.hash}`);
    } catch {
      // ambiente sem permissão para reescrever a URL: a tela segue funcionando, só não lembra o dia
    }
  }, [view, refDate, selectedProfessional]);

  const load = useCallback(async () => {
    const key = agendaKey(companyId, view, refDate, selectedProfessional);
    const hit = readScreenCache<unknown>(key);
    if (hit !== undefined) {
      if (view === "dia") setDayAppointments(hit as TimelineAppointment[]);
      if (view === "semana") setWeekAppointments(hit as WeekAppointment[]);
      if (view === "mes") setMonthByDay(hit as Map<string, { total: number; hasPending: boolean }>);
      setLoading(false);
    } else {
      setLoading(true);
    }
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
      const rows = (data as unknown as TimelineAppointment[]) ?? [];
      setDayAppointments(rows);
      if (data) writeScreenCache(key, rows);
    }

    if (view === "semana") {
      const days = getWeekDays(refDate);
      let query = supabase
        .from("appointments")
        .select("id, scheduled_start, scheduled_end, status, professional_member_id, clients(name), services(name)")
        .eq("company_id", companyId)
        .gte("scheduled_start", days[0].toISOString())
        .lt("scheduled_start", addDays(days[6], 1).toISOString())
        .order("scheduled_start");
      if (selectedProfessional !== "all") query = query.eq("professional_member_id", selectedProfessional);
      const { data } = await query;
      const rows = (data as unknown as WeekAppointment[]) ?? [];
      setWeekAppointments(rows);
      if (data) writeScreenCache(key, rows);
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
        // Chave do dia no relógio local — um atendimento às 22h não pode cair
        // no dia seguinte por causa de UTC.
        const key = localDayKey(a.scheduled_start);
        const cur = map.get(key) ?? { total: 0, hasPending: false };
        cur.total += 1;
        // "Em aberto" = qualquer atendimento ainda sem desfecho (agendado, e também
        // confirmado/em_atendimento caso existam). Só fica verde quando TODOS do dia
        // foram concluídos (cancelados e faltas já foram ignorados acima).
        if (a.status !== "concluido") cur.hasPending = true;
        map.set(key, cur);
      }
      setMonthByDay(map);
      if (data) writeScreenCache(key, map);
    }

    setLoading(false);
  }, [companyId, view, refDate, selectedProfessional]);

  useEffect(() => {
    load();
  }, [load]);

  // Bloqueios do período exibido. Consulta própria e leve: se falhar, a agenda
  // aparece normalmente, só sem os bloqueios. Sem cache de propósito: depois de
  // criar ou remover um bloqueio a tela tem que mostrar o que está no banco.
  useEffect(() => {
    let current = true;
    const days = view === "semana" ? getWeekDays(refDate) : view === "mes" ? getMonthGrid(refDate) : [refDate];
    const from = days[0];
    const to = addDays(days[days.length - 1], 1);
    let query = createClient()
      .from("blocked_times")
      .select(BLOCK_SELECT)
      .eq("company_id", companyId)
      .lt("start_at", to.toISOString())
      .gt("end_at", from.toISOString())
      .order("start_at");
    // só a profissional escolhida (e os da equipe toda); o id já foi validado ao ler a URL
    if (selectedProfessional !== "all") {
      query = query.or(`professional_member_id.eq.${selectedProfessional},professional_member_id.is.null`);
    }
    query.then(({ data, error }: { data: unknown; error: unknown }) => {
      if (!current) return;
      setBlocks(error || !Array.isArray(data) ? [] : (data as BlockedTime[]));
    });
    return () => {
      current = false;
    };
  }, [companyId, view, refDate, selectedProfessional]);

  // Previsão do período exibido (mesma regra do Início e do Financeiro:
  // lib/hive/forecast.ts). Consulta própria e leve (3 colunas, só os status que
  // entram na conta, limites no dia de Brasília), em paralelo com a da visão:
  // não atrasa a agenda e não muda nada para quem não vê valores.
  useEffect(() => {
    if (!canSeeFinance) return;
    let current = true;
    const period = agendaPeriod(view, refDate);
    const fKey = `agenda-prev:${companyId}:${view}:${period.start}:${selectedProfessional}`;
    setForecast(readScreenCache<Forecast>(fKey) ?? null);
    let query = createClient()
      .from("appointments")
      .select("price, status, scheduled_start")
      .eq("company_id", companyId)
      .in("status", [...FORECAST_STATUSES])
      .gte("scheduled_start", period.from)
      .lte("scheduled_start", period.to);
    if (selectedProfessional !== "all") query = query.eq("professional_member_id", selectedProfessional);
    query.then(({ data, error }) => {
      // descarta respostas de um período que já saiu da tela (setas clicadas rápido)
      if (!current) return;
      if (error) return setForecast("erro");
      const f = forecastFor((data as ForecastRow[] | null) ?? [], period.start, period.end);
      setForecast(f);
      writeScreenCache(fKey, f);
    });
    return () => {
      current = false;
    };
  }, [canSeeFinance, companyId, view, refDate, selectedProfessional]);

  const weekDays = useMemo(() => getWeekDays(refDate), [refDate]);
  const monthDays = useMemo(() => getMonthGrid(refDate), [refDate]);
  const activeDayAppointments = dayAppointments.filter((a) => a.status !== "cancelado" && a.status !== "nao_compareceu");
  const dayBlockCount = view === "dia" ? blocksOnDay(blocks, refDate).length : 0;
  const blockedDays = useMemo(() => allDayKeys(blocks), [blocks]);
  const dateParam = format(refDate, "yyyy-MM-dd");
  const profParam = selectedProfessional !== "all" ? `&prof=${selectedProfessional}` : "";

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
        <h1 className="page-title">Agenda</h1>
        <div className="flex items-center gap-2">
          <Link href={`/agenda/bloquear?data=${dateParam}${profParam}`}>
            <Button size="sm" variant="secondary">
              <CalendarOff className="size-4" />
              <span className="hidden sm:inline">Bloquear horário</span>
              <span className="sm:hidden">Bloquear</span>
            </Button>
          </Link>
          <Link href={`/agenda/novo?data=${dateParam}`}>
            <Button size="sm">
              <CalendarPlus className="size-4" />
              <span className="hidden sm:inline">Novo atendimento</span>
              <span className="sm:hidden">Novo</span>
            </Button>
          </Link>
        </div>
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

      <div className="space-y-1">
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
        {canSeeFinance && <PeriodForecast forecast={forecast} />}
      </div>

      <Card>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        ) : view === "dia" ? (
          activeDayAppointments.length === 0 && dayBlockCount === 0 ? (
            <EmptyState
              art="perfil"
              icon={CalendarX}
              title="Nenhum atendimento neste dia"
              description="Que tal aproveitar para organizar a agenda da semana?"
              action={
                <Link href={`/agenda/novo?data=${format(refDate, "yyyy-MM-dd")}`}>
                  <Button variant="accent" size="sm" className="rounded-full px-5">
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
              blocks={blocks}
            />
          )
        ) : view === "semana" ? (
          <WeekView
            days={weekDays}
            appointments={weekAppointments}
            professionals={professionals}
            showProfessional={selectedProfessional === "all" && professionals.length > 1}
            onSelectDay={selectDay}
            blocks={blocks}
          />
        ) : (
          <MonthGrid
            days={monthDays}
            reference={refDate}
            countByDay={monthByDay}
            onSelectDay={selectDay}
            blockedDays={blockedDays}
          />
        )}
      </Card>
    </div>
  );
}

// Faixa compacta com a previsão do período exibido, alinhada à direita, logo
// abaixo da navegação de datas. O esqueleto tem as mesmas alturas das duas
// linhas (h-7 e h-4) para a tela não pular quando o valor chega.
function PeriodForecast({ forecast }: { forecast: Forecast | "erro" | null }) {
  return (
    <div data-testid="agenda-forecast" aria-live="polite" aria-busy={forecast === null} className="flex min-w-0 flex-col items-end text-right">
      {forecast === null ? (
        <>
          <div className="flex h-7 items-center">
            <Skeleton className="h-5 w-40" />
          </div>
          <div className="flex h-4 w-full items-center justify-end">
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </>
      ) : forecast === "erro" ? (
        <>
          <p className="flex h-7 items-center text-xs font-medium text-ink-500">Previsto</p>
          <p className="h-4 text-xs leading-4 text-ink-400">Não foi possível calcular agora.</p>
        </>
      ) : (
        <>
          <p className="flex h-7 max-w-full items-baseline gap-2">
            <span className="text-xs font-medium text-ink-500">Previsto</span>
            <span data-testid="agenda-forecast-value" className="whitespace-nowrap font-serif text-lg font-medium leading-7 tabular-nums text-gold-700">
              {formatMoney(forecast.previsto)}
            </span>
          </p>
          <p className="flex max-w-full flex-wrap justify-end gap-x-1 text-xs leading-4 text-ink-400">
            <span className="whitespace-nowrap tabular-nums">{formatMoney(forecast.realizado)} realizado</span>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap tabular-nums">{formatMoney(forecast.agendado)} agendado</span>
          </p>
        </>
      )}
    </div>
  );
}
