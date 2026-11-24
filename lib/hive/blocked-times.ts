// Bloqueio de horário na Agenda (folga, almoço, consulta, férias...) — lógica PURA.
//
// Usa a tabela blocked_times (0001): profissional (ou toda a equipe, quando
// professional_member_id é nulo), início, fim e a observação em `reason`.
// Um bloqueio impede NOVOS agendamentos naquele período (a grade de horários de
// lib/hive/schedule.ts já o respeita); atendimentos que já existiam continuam
// na agenda. "Dia todo" = da meia-noite do primeiro dia à meia-noite depois do último,
// no relógio local (o mesmo relógio que desenha a agenda).
// Só importa um módulo vizinho sem dependências, para ser testável por tests/load-ts.cjs.
import { dayParam, parseDayParam } from "./agenda-url";

export type BlockedTime = {
  id: string;
  /** null = toda a equipe */
  professional_member_id: string | null;
  start_at: string;
  end_at: string;
  reason: string | null;
  /** Lembrete no celular, em minutos ANTES do início (0056). null/ausente = sem lembrete. */
  remind_before_minutes?: number | null;
};

export const BLOCK_SELECT = "id, professional_member_id, start_at, end_at, reason";
/** Só a tela de edição lê o lembrete; a agenda não precisa dele (e segue funcionando antes da 0056). */
export const BLOCK_SELECT_WITH_REMINDER = `${BLOCK_SELECT}, remind_before_minutes`;
export const REASON_MAX = 200;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_MS = 86_400_000;

export type BlockInput = {
  /** yyyy-MM-dd */
  date: string;
  /** yyyy-MM-dd; só vale com allDay (vários dias, ex.: férias). */
  endDate: string;
  allDay: boolean;
  /** HH:mm */
  start: string;
  /** HH:mm */
  end: string;
};

/** Início e fim do bloqueio como datas locais, ou a mensagem do que falta corrigir. */
export function blockRange(i: BlockInput): { start: Date; end: Date } | { error: string } {
  const day = parseDayParam(i.date);
  if (!day) return { error: "Escolha a data do bloqueio." };
  if (i.allDay) {
    const last = parseDayParam(i.endDate || i.date);
    if (!last) return { error: "Escolha a data final do bloqueio." };
    if (last < day) return { error: "A data final não pode ser antes da data inicial." };
    return { start: day, end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) };
  }
  if (!TIME_PATTERN.test(i.start) || !TIME_PATTERN.test(i.end)) return { error: "Informe o horário inicial e o final." };
  const [sh, sm] = i.start.split(":").map(Number);
  const [eh, em] = i.end.split(":").map(Number);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);
  if (end <= start) return { error: "O horário final precisa ser depois do inicial." };
  return { start, end };
}

/** Texto da observação já aparado; vazio vira null (a coluna aceita nulo). */
export function cleanReason(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");
  return t === "" ? null : t;
}

export function reasonProblem(text: string): string | null {
  return text.trim().length > REASON_MAX ? `A observação pode ter até ${REASON_MAX} caracteres.` : null;
}

const atMidnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;

/** Bloqueio de dia(s) inteiro(s): começa e termina à meia-noite local. */
export function isAllDay(b: Pick<BlockedTime, "start_at" | "end_at">): boolean {
  const s = new Date(b.start_at);
  const e = new Date(b.end_at);
  return e > s && atMidnight(s) && atMidnight(e);
}

/** Dias (yyyy-MM-dd, relógio local) que o bloqueio ocupa, do primeiro ao último. */
export function coveredDays(b: Pick<BlockedTime, "start_at" | "end_at">): string[] {
  const s = new Date(b.start_at);
  const e = new Date(b.end_at);
  if (!(e > s)) return [];
  const out: string[] = [];
  const last = new Date(e.getTime() - 1);
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(dayParam(d));
  }
  return out;
}

/** O bloqueio vale para esta coluna (profissional)? Nulo = toda a equipe. */
export function appliesToLane(b: Pick<BlockedTime, "professional_member_id">, laneId: string | null): boolean {
  return laneId === null || b.professional_member_id === null || b.professional_member_id === laneId;
}

/** Trecho do bloqueio dentro de um dia, em minutos desde a meia-noite; null se não toca o dia. */
export function clipToDay(
  b: Pick<BlockedTime, "start_at" | "end_at">,
  day: Date
): { startMin: number; endMin: number } | null {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const s = Math.max(new Date(b.start_at).getTime(), dayStart.getTime());
  const e = Math.min(new Date(b.end_at).getTime(), dayEnd.getTime());
  if (e <= s) return null;
  return {
    startMin: Math.round((s - dayStart.getTime()) / 60000),
    endMin: Math.min(1440, Math.round((e - dayStart.getTime()) / 60000)),
  };
}

/** Bloqueios que tocam o dia, do mais cedo ao mais tarde. */
export function blocksOnDay<T extends Pick<BlockedTime, "start_at" | "end_at">>(blocks: T[], day: Date): T[] {
  return blocks
    .filter((b) => clipToDay(b, day) !== null)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}

const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "Dia todo", "Dia todo · até 12/12" (vários dias) ou "12:00–13:00". */
export function blockWhenText(b: Pick<BlockedTime, "start_at" | "end_at">): string {
  if (isAllDay(b)) {
    const days = coveredDays(b);
    if (days.length <= 1) return "Dia todo";
    const [, mo, d] = days[days.length - 1].split("-");
    return `Dia todo · até ${d}/${mo}`;
  }
  return `${hhmm(new Date(b.start_at))}–${hhmm(new Date(b.end_at))}`;
}

/** O que a agenda escreve no bloqueio: a observação, ou um texto padrão se ela estiver vazia. */
export function blockLabel(b: Pick<BlockedTime, "start_at" | "end_at" | "reason">): string {
  const r = (b.reason ?? "").trim();
  if (r) return r;
  return isAllDay(b) ? "Dia bloqueado" : "Horário bloqueado";
}

/** Dias inteiros bloqueados no período (para marcar no mês). */
export function allDayKeys(blocks: Pick<BlockedTime, "start_at" | "end_at">[]): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) if (isAllDay(b)) for (const k of coveredDays(b)) out.add(k);
  return out;
}

/** Valores do formulário para um bloqueio já salvo, e se o formulário consegue representá-lo. */
export function blockToForm(b: Pick<BlockedTime, "start_at" | "end_at">): BlockInput & { representable: boolean } {
  const s = new Date(b.start_at);
  const e = new Date(b.end_at);
  if (isAllDay(b)) {
    const days = coveredDays(b);
    return { date: days[0], endDate: days[days.length - 1], allDay: true, start: "12:00", end: "13:00", representable: true };
  }
  const sameDay = dayParam(s) === dayParam(new Date(e.getTime() - 1)) || dayParam(s) === dayParam(e);
  return {
    date: dayParam(s),
    endDate: dayParam(s),
    allDay: false,
    start: hhmm(s),
    end: hhmm(e),
    // um bloqueio de horário que atravessa dias só é criado direto no banco; o formulário não o reescreve
    representable: sameDay && e.getTime() - s.getTime() < DAY_MS,
  };
}

/** Dois períodos se sobrepõem? (fim exclusivo) */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

// ---------------------------------------------------------------------------
// Lembrete no celular (0056). O valor é "minutos antes do início do bloqueio":
//   horário  -> 0 (na hora), 15, 30, 60, 120 ou 1440 (1 dia antes);
//   dia todo -> o início é a meia-noite, então: 360 (véspera às 18h) ou -480 (no próprio dia, às 8h).
// null = sem lembrete (o padrão).
// ---------------------------------------------------------------------------
export type RemindOption = { value: number | null; label: string };

export const REMIND_TIMED: readonly RemindOption[] = [
  { value: null, label: "Sem lembrete" },
  { value: 0, label: "Na hora" },
  { value: 15, label: "15 minutos antes" },
  { value: 30, label: "30 minutos antes" },
  { value: 60, label: "1 hora antes" },
  { value: 120, label: "2 horas antes" },
  { value: 1440, label: "1 dia antes" },
];
export const REMIND_ALL_DAY: readonly RemindOption[] = [
  { value: null, label: "Sem lembrete" },
  { value: -480, label: "No próprio dia, às 8h" },
  { value: 360, label: "Na véspera, às 18h" },
];
export const REMIND_MIN = -1440;
export const REMIND_MAX = 10080;

export function remindOptions(allDay: boolean): readonly RemindOption[] {
  return allDay ? REMIND_ALL_DAY : REMIND_TIMED;
}

/** O valor existe nas opções do tipo de bloqueio (horário ou dia todo)? null (sem lembrete) sempre vale. */
export function isValidRemind(allDay: boolean, v: number | null): boolean {
  return v === null || remindOptions(allDay).some((o) => o.value === v);
}

/** Ao trocar entre "horário" e "dia todo": mantém o lembrete se ele existir no outro tipo; senão, sem lembrete. */
export function remindAfterModeChange(allDay: boolean, current: number | null): number | null {
  return isValidRemind(allDay, current) ? current : null;
}

/** Quando o aviso chega: início menos a antecedência (negativa = depois do início, como "no dia, às 8h"). */
export function remindAt(startAt: string | Date, minutes: number): Date {
  return new Date(new Date(startAt).getTime() - minutes * 60000);
}

/** Texto do lembrete já salvo (para a lista); vazio se não houver. */
export function remindText(allDay: boolean, v: number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const hit = remindOptions(allDay).find((o) => o.value === v) ?? REMIND_TIMED.find((o) => o.value === v) ?? REMIND_ALL_DAY.find((o) => o.value === v);
  return hit ? hit.label : "";
}
