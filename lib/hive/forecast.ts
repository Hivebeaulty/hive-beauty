// ---------------------------------------------------------------------------
// PREVISÃO DE FATURAMENTO — lógica PURA (sem React, sem Supabase).
//
// Previsto = realizado + agendado no período:
//   * realizado: atendimentos CONCLUÍDOS (valor do atendimento);
//   * agendado:  atendimentos EM ABERTO (agendado, confirmado, em atendimento);
//   * cancelados e faltas ficam de fora.
// O dia de cada atendimento é o dia em Brasília (mesma regra do Financeiro).
// ---------------------------------------------------------------------------
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, format } from "date-fns";
import { toSaoPauloDate } from "./period";

export const FORECAST_STATUSES = ["concluido", "agendado", "confirmado", "em_atendimento"] as const;
const OPEN = new Set(["agendado", "confirmado", "em_atendimento"]);

export type ForecastRow = { price: number | string | null; status: string; scheduled_start: string };
export type Forecast = {
  realizado: number;
  agendado: number;
  previsto: number;
  /** quantidade de atendimentos concluídos no período */
  realizados: number;
  /** quantidade de atendimentos em aberto no período */
  agendados: number;
};

const cents = (n: number) => Math.round(n * 100) / 100;

/** Soma do período [start, end] (datas YYYY-MM-DD, inclusivas, no dia de Brasília). */
export function forecastFor(rows: ForecastRow[], start: string, end: string): Forecast {
  let realizado = 0, agendado = 0, realizados = 0, agendados = 0;
  for (const r of rows) {
    const day = toSaoPauloDate(r.scheduled_start);
    if (day < start || day > end) continue;
    const v = Number(r.price) || 0;
    if (r.status === "concluido") {
      realizado += v;
      realizados += 1;
    } else if (OPEN.has(r.status)) {
      agendado += v;
      agendados += 1;
    }
  }
  return { realizado: cents(realizado), agendado: cents(agendado), previsto: cents(realizado + agendado), realizados, agendados };
}

/** Hoje, esta semana (segunda a domingo) e este mês, a partir do dia de referência. */
export function forecastRanges(reference = new Date()) {
  const f = (d: Date) => format(d, "yyyy-MM-dd");
  const day = f(reference);
  return {
    hoje: { start: day, end: day },
    semana: { start: f(startOfWeek(reference, { weekStartsOn: 1 })), end: f(endOfWeek(reference, { weekStartsOn: 1 })) },
    mes: { start: f(startOfMonth(reference)), end: f(endOfMonth(reference)) },
  };
}

/** Um único intervalo que cobre hoje, a semana e o mês (a semana pode passar da virada do mês). */
export function forecastWindow(reference = new Date()) {
  const r = forecastRanges(reference);
  return {
    start: r.semana.start < r.mes.start ? r.semana.start : r.mes.start,
    end: r.semana.end > r.mes.end ? r.semana.end : r.mes.end,
  };
}

/** A previsão só faz sentido se o período ainda não terminou (há o que agendar nele). */
export function periodHasFuture(end: string, today = format(new Date(), "yyyy-MM-dd")): boolean {
  return end >= today;
}
