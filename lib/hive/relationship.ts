import { parseDateOnly, todayInBusinessTz } from "./format";

// ---------------------------------------------------------------------------
// CRM / Relacionamento — tudo aqui é derivado do histórico real de
// atendimentos concluídos. Nenhum dado novo é inventado; quando não há
// histórico suficiente, as funções devolvem null em vez de forçar uma
// estimativa (ver "hasEnoughHistory" abaixo).
// ---------------------------------------------------------------------------

// Cliente com só 1 atendimento não tem intervalo nenhum pra calcular uma
// média (precisa de pelo menos 2 visitas = 1 intervalo). Abaixo disso, cai
// no fallback simples por período fixo.
const MIN_VISITS_FOR_FREQUENCY = 2;
// "Fora do padrão" = já passou 1.5x o intervalo médio dela sem voltar.
const OVERDUE_MULTIPLIER = 1.5;
// Fallback só usado quando NÃO há histórico suficiente pra frequência
// pessoal (0 ou 1 visita) — é a única regra fixa que sobra, e só por falta
// de dado melhor, como o briefing previu.
const FALLBACK_INACTIVE_DAYS = 60;

const DAY_MS = 86400000;

export type ClientRelationship = {
  visitCount: number;
  lastVisitDate: Date | null;
  daysSinceLastVisit: number | null;
  avgIntervalDays: number | null; // null = sem histórico suficiente pra estimar
  nextEstimatedDate: Date | null;
  isOverdue: boolean;
  hasEnoughHistory: boolean;
};

// visitDates: datas de atendimentos CONCLUÍDOS de uma cliente, em qualquer ordem.
export function computeClientRelationship(visitDates: (string | Date)[], now = new Date()): ClientRelationship {
  const sorted = visitDates.map((d) => new Date(d)).sort((a, b) => a.getTime() - b.getTime());
  const visitCount = sorted.length;

  if (visitCount === 0) {
    return {
      visitCount: 0,
      lastVisitDate: null,
      daysSinceLastVisit: null,
      avgIntervalDays: null,
      nextEstimatedDate: null,
      isOverdue: false,
      hasEnoughHistory: false,
    };
  }

  const lastVisitDate = sorted[sorted.length - 1];
  const daysSinceLastVisit = Math.floor((now.getTime() - lastVisitDate.getTime()) / DAY_MS);

  const hasEnoughHistory = visitCount >= MIN_VISITS_FOR_FREQUENCY;
  let avgIntervalDays: number | null = null;
  let nextEstimatedDate: Date | null = null;

  if (hasEnoughHistory) {
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push((sorted[i].getTime() - sorted[i - 1].getTime()) / DAY_MS);
    }
    avgIntervalDays = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
    nextEstimatedDate = new Date(lastVisitDate.getTime() + avgIntervalDays * DAY_MS);
  }

  const isOverdue = hasEnoughHistory
    ? daysSinceLastVisit > avgIntervalDays! * OVERDUE_MULTIPLIER
    : daysSinceLastVisit > FALLBACK_INACTIVE_DAYS;

  return { visitCount, lastVisitDate, daysSinceLastVisit, avgIntervalDays, nextEstimatedDate, isOverdue, hasEnoughHistory };
}

export type ClientSegment =
  | "todas"
  | "novas"
  | "recorrentes"
  | "inativas"
  | "fora_do_padrao"
  | "aniversariantes";

// Os segmentos são ETIQUETAS, não grupos exclusivos: uma cliente pode estar em
// mais de um (ex.: "inativas" e "fora_do_padrao").
//   inativas        = passou do tempo esperado sem voltar. Usa o ritmo dela quando
//                     há histórico (>= 2 visitas) e o prazo fixo de 60 dias quando
//                     não há (comportamento original, preservado).
//   fora_do_padrao  = subconjunto de "inativas" com histórico SUFICIENTE: já passou
//                     de 1,5x o intervalo médio entre as visitas DELA. É a lista
//                     de maior confiança para uma futura mensagem de retorno.
export function classifySegments(rel: ClientRelationship, daysToNextBirthday: number | null): ClientSegment[] {
  const segs: ClientSegment[] = ["todas"];
  if (rel.isOverdue && rel.hasEnoughHistory) segs.push("fora_do_padrao");
  if (rel.isOverdue && rel.visitCount > 0) segs.push("inativas");
  else if (rel.visitCount >= MIN_VISITS_FOR_FREQUENCY) segs.push("recorrentes");
  else if (rel.visitCount <= 1) segs.push("novas");
  if (daysToNextBirthday !== null && daysToNextBirthday <= 30) segs.push("aniversariantes");
  return segs;
}

// Próximo aniversário a partir de hoje (0 = hoje, sempre >= 0).
// birthDate é um "date" do Postgres ("AAAA-MM-DD"): lido como dia do calendário,
// nunca via new Date(string) (que é UTC e erra um dia no Brasil). "Hoje" é o dia
// de America/Sao_Paulo, mesmo quando isto roda num servidor em UTC. Toda a conta
// é feita em dias de calendário (Date.UTC), então não há efeito de fuso/horário
// de verão. 29/02 em ano não bissexto cai em 01/03.
export function daysUntilNextBirthday(birthDate: string | null, now = new Date()): number | null {
  const bd = parseDateOnly(birthDate);
  if (!bd) return null;
  const t = todayInBusinessTz(now);
  const todayUtc = Date.UTC(t.y, t.m - 1, t.d);
  let next = Date.UTC(t.y, bd.getMonth(), bd.getDate());
  if (next < todayUtc) next = Date.UTC(t.y + 1, bd.getMonth(), bd.getDate());
  return Math.round((next - todayUtc) / DAY_MS);
}

export function birthdayLabel(days: number) {
  if (days === 0) return "Aniversário hoje";
  if (days === 1) return "Aniversário amanhã";
  return `Aniversário em ${days} dias`;
}
