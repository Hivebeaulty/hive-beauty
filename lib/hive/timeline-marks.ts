// Marcas do eixo de horários do Dia da Agenda — lógica PURA.
// De meia em meia hora (antes era de hora em hora). Sem imports (testável).

/** Intervalo entre as marcas do eixo, em minutos. */
export const MARK_STEP_MIN = 30;

/** Minutos desde a meia-noite de cada marca, do início ao fim (inclusive). */
export function timeMarks(startMin: number, endMin: number, step: number = MARK_STEP_MIN): number[] {
  const out: number[] = [];
  for (let m = startMin; m <= endMin; m += step) out.push(m);
  return out;
}

/** 510 -> "08:30". */
export function markLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Marca de hora cheia (a linha do grid fica um pouco mais forte que a da meia hora). */
export function isFullHour(min: number): boolean {
  return min % 60 === 0;
}
