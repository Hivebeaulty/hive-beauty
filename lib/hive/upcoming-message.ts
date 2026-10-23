// ---------------------------------------------------------------------------
// Próximos atendimentos da cliente (ficha da cliente) — regras PURAS.
//   * splitAppointments: separa PRÓXIMOS (agendado/confirmado, a partir de agora,
//     do mais perto para o mais longe) do HISTÓRICO (todo o resto).
//   * buildUpcomingMessage: texto para a cliente com todos os próximos horários,
//     serviços e datas (America/Sao_Paulo). Mesmo tom da confirmação: feminino,
//     acolhedor, primeira pessoa do singular, sem assinatura, no máximo 1 emoji.
//   * upcomingSendKey: chave de idempotência do envio pela fila (wa_send_message).
//     Mesma cliente + mesmo texto + mesmo dia => mesma chave: um toque duplo ou
//     um "enviar de novo" no mesmo dia NÃO manda a mensagem duas vezes.
// ---------------------------------------------------------------------------
import { firstName } from "./format";
import { formatDayLabel, formatTimeLabel } from "./appointment-message";
import { servicesLabel } from "./extra-services";

const TZ = "America/Sao_Paulo";

/** Status que ainda vão acontecer. em_atendimento já começou; os outros já terminaram. */
export const UPCOMING_STATUSES = ["agendado", "confirmado"] as const;

/** Acima disso a mensagem fica longa demais para WhatsApp: lista os primeiros e resume o resto. */
export const MAX_MESSAGE_ITEMS = 15;

export type ApptLike = { scheduled_start: string; status: string };

export function isUpcoming(a: ApptLike, now: Date = new Date()): boolean {
  return (UPCOMING_STATUSES as readonly string[]).includes(a.status) && new Date(a.scheduled_start).getTime() >= now.getTime();
}

export function splitAppointments<T extends ApptLike>(list: T[], now: Date = new Date()): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const a of list) (isUpcoming(a, now) ? upcoming : past).push(a);
  const t = (a: T) => new Date(a.scheduled_start).getTime();
  upcoming.sort((a, b) => t(a) - t(b));
  past.sort((a, b) => t(b) - t(a));
  return { upcoming, past };
}

/** Nomes do serviço principal + adicionais (na ordem gravada), como "Manicure e Pedicure". */
export function appointmentServicesLabel(
  primary: string | null | undefined,
  extras: { position?: number | null; name: string | null | undefined }[] = []
): string {
  const ordered = [...extras].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return servicesLabel([primary, ...ordered.map((e) => e.name)]);
}

export type UpcomingItem = { startsAt: string | Date; serviceName: string };

function partsOf(d: Date) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) {
    p[x.type] = x.value;
  }
  return { hour: Number(p.hour), minute: Number(p.minute) };
}

/** "• quinta-feira, 24/10, às 14h — Manicure e Pedicure" (hoje/amanhã por extenso). */
export function upcomingLine(item: UpcomingItem, now: Date = new Date()): string {
  const d = typeof item.startsAt === "string" ? new Date(item.startsAt) : item.startsAt;
  const { hour, minute } = partsOf(d);
  const svc = item.serviceName.trim();
  return `• ${formatDayLabel(d, now)}, às ${formatTimeLabel(hour, minute)}${svc ? ` — ${svc}` : ""}`;
}

export function buildUpcomingMessage(i: { clientName: string; items: UpcomingItem[]; now?: Date }): string {
  const now = i.now ?? new Date();
  const items = [...i.items].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const nome = firstName(i.clientName);
  const greeting = nome ? `Oi, ${nome}, tudo bem?` : "Oi, tudo bem?";
  if (items.length === 0) return "";

  const shown = items.slice(0, MAX_MESSAGE_ITEMS);
  const rest = items.length - shown.length;
  const lines = shown.map((it) => upcomingLine(it, now));
  if (rest > 0) lines.push(`• e mais ${rest} ${rest === 1 ? "horário" : "horários"} já agendados`);

  const one = items.length === 1;
  const intro = one ? "Passando para te lembrar do seu próximo horário:" : "Passando para te lembrar dos seus próximos horários:";
  const close = one ? "Se precisar remarcar, é só me avisar por aqui. 💕" : "Se precisar remarcar algum, é só me avisar por aqui. 💕";
  return `${greeting}\n\n${intro}\n\n${lines.join("\n")}\n\n${close}`;
}

function hash(str: string): string {
  let h = 0;
  for (let k = 0; k < str.length; k++) h = (h * 31 + str.charCodeAt(k)) >>> 0;
  return h.toString(36);
}

/** Dia no fuso do negócio, "2026-10-22". */
function businessYmd(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function upcomingSendKey(clientId: string, body: string, now: Date = new Date()): string {
  return `upcoming:${clientId}:${businessYmd(now)}:${hash(body.trim())}`;
}

// Erros do banco (wa_send_message, migration 0017) em texto para a tela.
export function sendErrorMessage(code: string | null | undefined, detail?: string | null): string {
  switch (code) {
    case "AUW01":
      return "O WhatsApp do negócio não está conectado. Use “Abrir no meu WhatsApp”.";
    case "AUW02":
      return detail === "blocked"
        ? "Esta cliente pediu para não receber mensagens."
        : "Esta cliente não tem um celular válido para WhatsApp.";
    case "AUW03":
      return "Limite de envios atingido. Tente de novo em instantes.";
    case "AUW05":
      return "A mensagem está vazia ou longa demais.";
    case "42501":
      return "Seu papel não permite enviar mensagens.";
    default:
      return "Não foi possível enviar. Tente de novo.";
  }
}
