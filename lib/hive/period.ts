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

// ---------------------------------------------------------------------------
// Fuso do negócio: America/Sao_Paulo (UTC-3 fixo — o Brasil não tem horário de
// verão desde 2019). Todo filtro por intervalo de datas contra colunas
// timestamptz deve usar estes limites explícitos; "2026-09-27T23:59:59" sem
// offset é interpretado como UTC e perde tudo que aconteceu à noite (depois
// das 21h em Brasília já é o dia seguinte em UTC).
// ---------------------------------------------------------------------------
export function periodBoundsISO(start: string, end: string) {
  return { from: `${start}T00:00:00-03:00`, to: `${end}T23:59:59.999-03:00` };
}

// "Que dia (em Brasília) foi esse timestamp?" -> "YYYY-MM-DD"
export function toSaoPauloDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
