const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function formatMoney(value: number | null | undefined) {
  return currencyFormatter.format(value ?? 0);
}

export function greetingForHour(hour: number) {
  if (hour < 5) return "Boa noite";
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

export function firstName(fullName: string | null | undefined) {
  if (!fullName) return null;
  return fullName.trim().split(/\s+/)[0] || null;
}

// Link "abrir conversa no WhatsApp" (manual, 1 cliente por vez) — nenhuma
// automação. Delega para lib/hive/phone.ts: só celular válido gera link, e o
// DDD 55 (RS) não é mais confundido com o código do país.
export { whatsappChatLink as whatsappLink } from "./phone";

// Datas "só dia" (date do Postgres, ex.: "1990-03-15") NÃO podem passar por
// new Date("1990-03-15"): isso é interpretado como meia-noite UTC e, no Brasil
// (UTC-3), vira o dia ANTERIOR ao formatar. Aqui montamos a data no fuso local.
export function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  // Meio-dia (e não meia-noite): nenhuma virada de horário de verão ou de fuso
  // consegue empurrar essa data para outro dia.
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

export const BUSINESS_TIMEZONE = "America/Sao_Paulo";

// "Hoje" no fuso do NEGÓCIO, não no do servidor ou do aparelho. Em Server
// Components na Vercel o relógio local é UTC: às 22h em Brasília o servidor já
// está no dia seguinte, e tudo que dependa de "que dia é hoje" erraria um dia.
export function todayInBusinessTz(now: Date = new Date()): { y: number; m: number; d: number } {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "2026-10-01"
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

export function formatDateOnly(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const d = parseDateOnly(value);
  return d ? d.toLocaleDateString("pt-BR", options) : "—";
}

// "Alongamento · R$ 120 · 2h" em vez de "120min" — duração é informação
// operacional (quanto da agenda o serviço ocupa), não só um número de form.
export function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}`;
}
