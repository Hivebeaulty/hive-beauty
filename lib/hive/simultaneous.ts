// Mais de uma cliente no mesmo horário (migration 0053). Lógica pura da tela.
// A autoridade é o banco: o gatilho appointments_overlap_guard recusa com AOV01 (ligado, sem
// confirmação) ou 23P01 (desligado). Aqui só montamos a pergunta e achamos quem já está no horário.

export const OVERLAP_CODE = "AOV01";

/** O erro do banco pede a confirmação da profissional ("agendar junto?")? */
export function needsOverlapConfirmation(code: string | null | undefined): boolean {
  return code === OVERLAP_CODE;
}

export type OverlapCandidate = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  clients?: { name: string } | null;
};

export type OverlapInfo = { id: string; clientName: string; start: Date };

const INACTIVE = ["cancelado", "nao_compareceu"];

/** Atendimentos abertos que se sobrepõem ao intervalo [start, end) — o mesmo critério do banco. */
export function findOverlaps(
  rows: OverlapCandidate[],
  start: Date,
  end: Date,
  excludeId?: string
): OverlapInfo[] {
  return rows
    .filter((r) => r.id !== excludeId && !INACTIVE.includes(r.status))
    .filter((r) => new Date(r.scheduled_start) < end && new Date(r.scheduled_end) > start)
    .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
    .map((r) => ({ id: r.id, clientName: r.clients?.name ?? "outra cliente", start: new Date(r.scheduled_start) }));
}

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}h${d.getMinutes() ? String(d.getMinutes()).padStart(2, "0") : ""}`;

function joinNames(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/** Texto da pergunta antes de agendar junto. */
export function overlapQuestion(existing: OverlapInfo[], newClientName: string): { title: string; body: string } {
  const who = existing.length
    ? joinNames(existing.map((o) => `${o.clientName} às ${hhmm(o.start)}`))
    : "outra cliente nesse horário";
  const name = newClientName.trim() || "essa cliente";
  return {
    title: "Já tem cliente nesse horário",
    body: existing.length
      ? `Você já tem ${who}. Quer agendar ${name} também nesse horário?`
      : `Você já tem atendimento nesse horário. Quer agendar ${name} também?`,
  };
}

/** Rótulo do horário na grade quando já está ocupado (só aparece com a opção ligada). */
export const OCCUPIED_SLOT_HINT = "Já tem cliente. Toque para agendar junto.";
