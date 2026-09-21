import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, format } from "date-fns";

export type Period = "hoje" | "semana" | "mes";

export const PERIOD_LABEL: Record<Period, string> = {
  hoje: "Hoje",
  semana: "Esta semana",
  mes: "Este mês",
};

// Cálculo sempre no relógio local do dispositivo (mesma decisão da Agenda),
// para não haver descompasso entre o dia que a profissional vê no celular
// e o período usado nos indicadores.
export function getPeriodRange(period: Period, reference = new Date()) {
  let start: Date;
  let end: Date;

  if (period === "hoje") {
    start = reference;
    end = reference;
  } else if (period === "semana") {
    start = startOfWeek(reference, { weekStartsOn: 1 });
    end = endOfWeek(reference, { weekStartsOn: 1 });
  } else {
    start = startOfMonth(reference);
    end = endOfMonth(reference);
  }

  return { start: format(start, "yyyy-MM-dd"), end: format(end, "yyyy-MM-dd") };
}
