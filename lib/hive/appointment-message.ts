// ---------------------------------------------------------------------------
// Mensagem de CONFIRMAÇÃO de agendamento para a cliente (WhatsApp, manual).
//
// Isto só monta o TEXTO. Nada é enviado: a tela abre o WhatsApp com a mensagem
// pronta e quem decide enviar é a profissional. Não é a integração automática
// (essa vem depois, em serviço separado).
//
// Tom: uma profissional de verdade confirmando um horário — curta, calorosa,
// sem excesso de emoji. Para não soar "robô", há 3 aberturas/fechamentos; a
// escolha é DETERMINÍSTICA (mesma entrada, mesma mensagem), então é testável e
// não muda se a tela for reaberta. Datas e horas sempre em America/Sao_Paulo,
// qualquer que seja o fuso do servidor ou do aparelho.
// ---------------------------------------------------------------------------
import { firstName, formatDuration } from "./format";

const TZ = "America/Sao_Paulo";

export type ConfirmationInput = {
  clientName: string;
  startsAt: Date | string;
  durationMinutes: number;
  serviceName: string;
  /** Como a profissional quer ser chamada (ex.: "Paty"). */
  professionalName?: string | null;
  businessName?: string | null;
  now?: Date;
  /** Define a variação do texto; por padrão deriva do cliente + horário. */
  variantSeed?: string;
};

type Parts = { weekday: string; day: string; month: string; hour: number; minute: number; ymd: string };

function partsOf(d: Date): Parts {
  const f = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return {
    weekday: p.weekday,
    day: p.day,
    month: p.month,
    hour: Number(p.hour),
    minute: Number(p.minute),
    ymd: `${p.year}-${p.month}-${p.day}`,
  };
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

// 14h, 14h30, 9h
export function formatTimeLabel(hour: number, minute: number): string {
  return minute === 0 ? `${hour}h` : `${hour}h${String(minute).padStart(2, "0")}`;
}

// "terça-feira, 15/10"  |  "amanhã, quarta-feira (16/10)"  |  "hoje, terça-feira (15/10)"
export function formatDayLabel(startsAt: Date, now: Date = new Date()): string {
  const s = partsOf(startsAt);
  const today = partsOf(now).ymd;
  const date = `${s.day}/${s.month}`;
  if (s.ymd === today) return `hoje, ${s.weekday} (${date})`;
  if (s.ymd === addDaysYmd(today, 1)) return `amanhã, ${s.weekday} (${date})`;
  return `${s.weekday}, ${date}`;
}

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function signature(professional?: string | null, business?: string | null): string {
  const p = (professional ?? "").trim();
  const b = (business ?? "").trim();
  if (p && b && p.toLowerCase() !== b.toLowerCase()) return `${p} · ${b}`;
  return p || b;
}

export function buildConfirmationMessage(i: ConfirmationInput): string {
  const startsAt = typeof i.startsAt === "string" ? new Date(i.startsAt) : i.startsAt;
  const s = partsOf(startsAt);
  const when = `${formatDayLabel(startsAt, i.now)}, às ${formatTimeLabel(s.hour, s.minute)}`;

  const nome = firstName(i.clientName);
  const service = i.serviceName.trim();
  const duration = i.durationMinutes > 0 ? formatDuration(i.durationMinutes) : "";
  const serviceLine = [service, duration].filter(Boolean).join(" · ");
  const sign = signature(i.professionalName, i.businessName);

  const variant = hash(i.variantSeed ?? `${i.clientName}|${startsAt.toISOString()}`) % 3;

  const greeting = [
    nome ? `Oi, ${nome}! 💛` : "Oi! 💛", // o ÚNICO emoji da mensagem
    nome ? `Oi, ${nome}, tudo bem?` : "Oi, tudo bem?",
    nome ? `Oi, ${nome}!` : "Oi!",
  ][variant];

  const intro = [
    `Seu horário está confirmado: ${when}.`,
    `Passando para confirmar o seu horário: ${when}.`,
    `Seu atendimento está marcado para ${when}.`,
  ][variant];

  const closing = [
    "Qualquer imprevisto, é só me avisar por aqui. Te espero!",
    "Se precisar remarcar, me avisa por aqui, combinado?",
    "Vai ser um prazer te receber! Se algo mudar, é só me chamar por aqui.",
  ][variant];

  return [greeting, "", intro, serviceLine, "", closing, sign]
    .filter((line, idx, arr) => !(line === "" && (idx === 0 || arr[idx - 1] === "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
