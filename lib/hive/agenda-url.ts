// Estado da Agenda na URL (visão, dia de referência e profissional) — lógica PURA.
//
// Por quê: ao abrir um atendimento e tocar em "Voltar", a Agenda é montada de
// novo. Antes ela sempre voltava para hoje, porque o dia consultado só existia
// na memória da tela. Agora o dia fica na própria URL (`/agenda?data=2026-11-25`),
// e o "Voltar" do navegador devolve exatamente a mesma tela.
//
// Regras:
//   * só entra na URL o que foge do padrão (visão Dia, hoje, todas as profissionais);
//     quem abre a aba Agenda continua caindo em hoje;
//   * parâmetros de outros assuntos que já estejam na URL são preservados;
//   * valor inválido é ignorado (cai no padrão), nunca quebra a tela.
// Sem imports: carregável pelos testes (tests/load-ts.cjs).

export type AgendaViewParam = "dia" | "semana" | "mes";

export type AgendaUrlState = {
  view: AgendaViewParam;
  /** Dia de referência, à meia-noite no relógio local. */
  date: Date;
  /** Id da profissional ou "all". */
  professional: string;
};

type ParamReader = { get(name: string): string | null } | null | undefined;

const VIEWS: readonly string[] = ["dia", "semana", "mes"];
const PROFESSIONAL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const pad = (n: number) => String(n).padStart(2, "0");

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "2026-11-25" a partir do dia no relógio local (nunca por UTC). */
export function dayParam(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-11-25" -> Date local à meia-noite; null se não for uma data real. */
export function parseDayParam(value: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  const date = new Date(y, mo - 1, d);
  // rejeita 2026-02-31 e similares (o Date "corrige" para o mês seguinte)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** Estado inicial da Agenda: o que a URL pede, ou o padrão (Dia, hoje, todas). */
export function readAgendaState(params: ParamReader, today: Date): AgendaUrlState {
  const v = params?.get("visao") ?? "";
  const p = params?.get("prof") ?? "";
  return {
    view: VIEWS.includes(v) ? (v as AgendaViewParam) : "dia",
    date: parseDayParam(params?.get("data")) ?? startOfLocalDay(today),
    professional: PROFESSIONAL_PATTERN.test(p) ? p : "all",
  };
}

/**
 * Nova query string (com "?" na frente, ou "" se ficou vazia) para o estado
 * atual, partindo da query string que já está na URL.
 */
export function writeAgendaSearch(currentSearch: string, state: AgendaUrlState, today: Date): string {
  const q = new URLSearchParams(currentSearch);
  const set = (key: string, value: string | null) => (value === null ? q.delete(key) : q.set(key, value));
  set("visao", state.view === "dia" ? null : state.view);
  set("data", dayParam(state.date) === dayParam(today) ? null : dayParam(state.date));
  set("prof", state.professional === "all" ? null : state.professional);
  const s = q.toString();
  return s ? `?${s}` : "";
}
