// Cortesia com prazo (0054) — regras PURAS das telas do painel. Nada aqui é segurança: quem pode criar,
// estender ou encerrar é decidido pelo BANCO (admin_assert: superadmin + verificação em duas etapas).
// Datas sempre no fuso de Brasília; a cortesia vale até as 23:59:59 do último dia.
import type { BadgeTone } from "@/components/ui/badge";

const TZ = "America/Sao_Paulo";
export const COURTESY_PRESETS = [30, 90] as const;
export const COURTESY_MIN_DAYS = 1;
export const COURTESY_MAX_DAYS = 365;

export type CourtesyOrigin = "parceria" | "indicacao" | "outro";
export const ORIGIN_LABEL: Record<CourtesyOrigin, string> = { parceria: "Parceria", indicacao: "Indicação", outro: "Outro" };

export type CourtesySituation = "ativa" | "termina_em_breve" | "encerrada" | "revogada" | "sem_prazo";
export const SITUATION_LABEL: Record<CourtesySituation, string> = {
  ativa: "Ativa",
  termina_em_breve: "Termina em breve",
  encerrada: "Encerrada",
  revogada: "Encerrada por você",
  sem_prazo: "Sem prazo",
};
export const SITUATION_TONE: Record<CourtesySituation, BadgeTone> = {
  ativa: "success",
  termina_em_breve: "warning",
  encerrada: "muted",
  revogada: "muted",
  sem_prazo: "wine",
};

export type Courtesy = {
  id: string | null;
  email: string;
  name: string | null;
  origin: CourtesyOrigin | null;
  reason: string | null;
  days: number | null;
  grantedAt: string | null;
  endsAt: string | null;
  extensions: number;
  grantedBy: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  hasAccount: boolean;
  situation: CourtesySituation;
  /** Situação de acesso agora: "active" etc. quando já virou assinatura. */
  nowStatus: string | null;
  companyId: string | null;
};

const iso = (v: unknown) => (typeof v === "string" && !isNaN(Date.parse(v)) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const SITUATIONS = Object.keys(SITUATION_LABEL) as CourtesySituation[];

/** Resposta de admin_list_courtesies -> lista da tela. Formato inesperado ou erro -> null. */
export function parseCourtesies(data: unknown, error: unknown): Courtesy[] | null {
  if (error || !Array.isArray(data)) return null;
  const out: Courtesy[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Record<string, unknown>;
    if (typeof d.email !== "string" || !SITUATIONS.includes(d.situation as CourtesySituation)) continue;
    out.push({
      id: str(d.id),
      email: d.email,
      name: str(d.name),
      origin: d.origin === "parceria" || d.origin === "indicacao" || d.origin === "outro" ? d.origin : null,
      reason: str(d.reason),
      days: typeof d.days === "number" ? d.days : null,
      grantedAt: iso(d.granted_at),
      endsAt: iso(d.ends_at),
      extensions: typeof d.extensions === "number" ? d.extensions : 0,
      grantedBy: str(d.granted_by),
      revokedAt: iso(d.revoked_at),
      revokedReason: str(d.revoked_reason),
      hasAccount: d.has_account === true,
      situation: d.situation as CourtesySituation,
      nowStatus: str(d.now_status),
      companyId: str(d.company_id),
    });
  }
  return out;
}

/** Ela já virou assinante durante ou depois da cortesia? */
export const convertedToPaying = (c: Courtesy) => c.nowStatus === "active" || c.nowStatus === "trialing" || c.nowStatus === "past_due";

// --- datas ------------------------------------------------------------------------------
function ymdBR(d: Date): [number, number, number] {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).split("-").map(Number);
  return [p[0], p[1], p[2]];
}
const fmt = (y: number, m: number, d: number) => `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;

/** "15/12/2026": o último dia da cortesia concedida hoje por `days` dias (mesma conta do banco). */
export function courtesyEndPreview(days: number, now: Date = new Date()): string {
  const [y, m, d] = ymdBR(now);
  const end = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
}
/** Mesma conta para estender: soma `days` ao fim atual (ainda valendo) ou conta de hoje (já vencida). */
export function extendEndPreview(currentEndIso: string | null, days: number, now: Date = new Date()): string {
  if (currentEndIso && new Date(currentEndIso) > now) {
    const [y, m, d] = ymdBR(new Date(currentEndIso));
    const end = new Date(Date.UTC(y, m - 1, d + days));
    return fmt(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
  }
  return courtesyEndPreview(days, now);
}
export function formatDay(iso: string | null | undefined): string {
  if (!iso || isNaN(Date.parse(iso))) return "—";
  const [y, m, d] = ymdBR(new Date(iso));
  return fmt(y, m, d);
}
/** Quantos dias faltam (0 = termina hoje; negativo = já terminou), pelo dia de Brasília. */
export function daysLeft(endIso: string | null, now: Date = new Date()): number | null {
  if (!endIso || isNaN(Date.parse(endIso))) return null;
  const [y1, m1, d1] = ymdBR(now);
  const [y2, m2, d2] = ymdBR(new Date(endIso));
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// --- formulário --------------------------------------------------------------------------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export type GrantForm = { email: string; name: string; days: number; origin: CourtesyOrigin | ""; reason: string };

/** Primeira coisa errada do formulário, em português (o banco confere tudo de novo). */
export function grantFormProblem(f: GrantForm): string | null {
  const email = f.email.trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return "Digite um e-mail válido.";
  if (!Number.isInteger(f.days) || f.days < COURTESY_MIN_DAYS || f.days > COURTESY_MAX_DAYS) return `O prazo vai de ${COURTESY_MIN_DAYS} a ${COURTESY_MAX_DAYS} dias.`;
  if (!f.origin) return "Escolha a origem da cortesia.";
  const r = f.reason.trim();
  if (r.length < 5 || r.length > 500) return "Escreva o motivo (de 5 a 500 caracteres).";
  if (f.name.trim().length > 120) return "O nome está muito longo.";
  return null;
}
export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  return r.length < 5 || r.length > 500 ? "Escreva o motivo (de 5 a 500 caracteres)." : null;
}

/** Erro do banco ou da função -> texto para a dona. */
export function courtesyErrorMessage(code: string | null | undefined, message: string | null | undefined): string {
  if (code === "AUA01" || code === "42501" || code === "28000") return "Confirme o acesso com a verificação em duas etapas e tente de novo.";
  const known = ["ACG01", "ACG02", "ACG03", "ACG04", "ACG05", "22023", "P0002"];
  if (code && known.includes(code) && message) return message;
  return "Não foi possível concluir agora. Tente de novo em instantes.";
}

/** O que dizer depois de oferecer a cortesia, conforme a conta e o e-mail. */
export function grantResultMessage(r: { account?: { created?: boolean; emailSent?: boolean; hadAccount?: boolean; error?: boolean } }, email: string, endDay: string): string {
  const a = r.account ?? {};
  if (a.error) return `Cortesia criada até ${endDay}, mas não foi possível criar o acesso de ${email}. Use "Reenviar e-mail" na lista.`;
  if (a.created && a.emailSent) return `Cortesia criada até ${endDay}. Enviamos para ${email} o e-mail para criar a senha.`;
  if (a.created && !a.emailSent) return `Cortesia criada até ${endDay}. O acesso foi criado, mas o e-mail não saiu. Use "Reenviar e-mail" na lista.`;
  return `Cortesia criada até ${endDay}. ${email} já tem conta e entra com a senha de sempre.`;
}
