import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, subMonths, format } from "date-fns";

export type Period = "hoje" | "semana" | "mes" | "mes_anterior" | "personalizado";

export const PERIOD_LABEL: Record<Period, string> = {
  hoje: "Hoje",
  semana: "Esta semana",
  mes: "Este mês",
  mes_anterior: "Mês anterior",
  personalizado: "Personalizado",
};

// Cálculo sempre no relógio local do dispositivo (mesma decisão da Agenda),
// para não haver descompasso entre o dia que a profissional vê no celular
// e o período usado nos indicadores.
//
// "personalizado" precisa de um intervalo explícito (custom) — sem ele, cai
// no mês atual como padrão seguro em vez de quebrar.
export function getPeriodRange(period: Period, reference = new Date(), custom?: { start: string; end: string }) {
  if (period === "personalizado") {
    if (custom) return custom;
    period = "mes";
  }

  let start: Date;
  let end: Date;

  if (period === "hoje") {
    start = reference;
    end = reference;
  } else if (period === "semana") {
    start = startOfWeek(reference, { weekStartsOn: 1 });
    end = endOfWeek(reference, { weekStartsOn: 1 });
  } else if (period === "mes_anterior") {
    const prev = subMonths(reference, 1);
    start = startOfMonth(prev);
    end = endOfMonth(prev);
  } else {
    start = startOfMonth(reference);
    end = endOfMonth(reference);
  }

  return { start: format(start, "yyyy-MM-dd"), end: format(end, "yyyy-MM-dd") };
}
