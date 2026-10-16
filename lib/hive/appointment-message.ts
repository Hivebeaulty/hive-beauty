// ---------------------------------------------------------------------------
// Mensagem de CONFIRMAÇÃO de agendamento para a cliente (WhatsApp).
//
// ÚNICA regra de texto da confirmação, com DUAS cópias que precisam ficar
// idênticas (teste de paridade em supabase/tests/local/0018_message_parity.cjs):
//   * esta, usada pela tela no envio manual (wa.me);
//   * whatsapp_private.confirmation_text no banco (migration 0019), usada na
//     confirmação AUTOMÁTICA.
//
// Tom: feminino, acolhedor e natural, de salão de beleza; sem exagero e sem
// soar comercial. Na PRIMEIRA PESSOA DO SINGULAR: quem fala é a profissional
// ("te espero", "me avise"), nunca uma equipe ("te esperamos", "a gente"). Emoji só em parte das variações (no máximo 1 por mensagem).
// SEM assinatura: a mensagem termina naturalmente, sem nome de empresa nem de
// profissional. Sempre traz serviço, dia e horário (America/Sao_Paulo).
//
// 8 variações. A escolha é DETERMINÍSTICA pela semente (o id do agendamento):
// o mesmo agendamento sempre gera a mesma variação — inclusive quando o banco
// refaz o texto antes do envio — e a idempotência por agendamento continua
// impedindo mensagens duplicadas.
// ---------------------------------------------------------------------------
import { firstName } from "./format";
import { confirmationTemplateProblems, renderConfirmationTemplate } from "./message-template";

const TZ = "America/Sao_Paulo";

export type ConfirmationInput = {
  clientName: string;
  startsAt: Date | string;
  durationMinutes: number;
  serviceName: string;
  /** Mantido por compatibilidade; NÃO entra mais no texto (sem assinatura). */
  professionalName?: string | null;
  /** Não entra no texto do sistema (sem assinatura); só na mensagem própria, via {negocio}. */
  businessName?: string | null;
  /**
   * Opção 2: mensagem própria da empresa (com {nome}, {data}...). Ausente ou
   * inválida => mensagens variadas do sistema (opção 1). Mesma regra do banco.
   */
  customTemplate?: string | null;
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

// Como o dia entra na frase. Dois encaixes, para a frase ficar sempre correta:
//   em:   "no dia 15/10 (quinta-feira)"  → "Te espero no dia 15/10 (quinta-feira), às 14h"
//   para: "o dia 15/10 (quinta-feira)"   → "ficou para o dia 15/10 (quinta-feira), às 14h"
// Hoje/amanhã servem nos dois:            "hoje, quinta-feira (15/10)" / "amanhã, quinta-feira (15/10)"
export function dayPhrases(startsAt: Date, now: Date = new Date()): { em: string; para: string } {
  const s = partsOf(startsAt);
  const today = partsOf(now).ymd;
  const date = `${s.day}/${s.month}`;
  if (s.ymd === today) return { em: `hoje, ${s.weekday} (${date})`, para: `hoje, ${s.weekday} (${date})` };
  if (s.ymd === addDaysYmd(today, 1)) return { em: `amanhã, ${s.weekday} (${date})`, para: `amanhã, ${s.weekday} (${date})` };
  return { em: `no dia ${date} (${s.weekday})`, para: `o dia ${date} (${s.weekday})` };
}

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

export const CONFIRMATION_VARIANTS = 8;

/** Qual das 8 variações uma semente usa (mesma semente → mesma variação). */
export function confirmationVariant(seed: string): number {
  return hash(seed) % CONFIRMATION_VARIANTS;
}

export function buildConfirmationMessage(i: ConfirmationInput): string {
  const startsAt = typeof i.startsAt === "string" ? new Date(i.startsAt) : i.startsAt;
  const s = partsOf(startsAt);
  if (i.customTemplate && confirmationTemplateProblems(i.customTemplate).length === 0) {
    return renderConfirmationTemplate(i.customTemplate, {
      nome: firstName(i.clientName) ?? "",
      negocio: (i.businessName ?? "").trim(),
      servico: i.serviceName.trim(),
      data: `${s.day}/${s.month}`,
      dia_semana: s.weekday,
      horario: formatTimeLabel(s.hour, s.minute),
    });
  }
  const { em, para } = dayPhrases(startsAt, i.now);
  const hora = `às ${formatTimeLabel(s.hour, s.minute)}`;

  const nome = firstName(i.clientName);
  const sv = i.serviceName.trim();
  const oi = nome ? `Oi, ${nome}!` : "Oi!";
  const oiTudoBem = nome ? `Oi, ${nome}, tudo bem?` : "Oi, tudo bem?";

  const variant = confirmationVariant(i.variantSeed ?? `${i.clientName}|${startsAt.toISOString()}`);

  // [abertura, corpo] — cada corpo traz serviço (quando houver), dia e horário
  const [greeting, body] = ([
    [oi, `Seu horário está confirmado! Te espero ${em}, ${hora}${sv ? `, para ${sv}` : ""}. 💕`],
    [oi, `Tudo certinho com o seu agendamento${sv ? ` de ${sv}` : ""}: ficou para ${para}, ${hora}. Até lá!`],
    [oi, `Agendamento confirmado! Vou te esperar ${em}, ${hora}${sv ? `, para ${sv}` : ""}. ✨`],
    [oiTudoBem, `Passando para confirmar o seu horário${sv ? `: ${sv}` : ""} ${em}, ${hora}. Qualquer imprevisto, é só me avisar por aqui.`],
    [oi, `Seu horário${sv ? ` de ${sv}` : ""} está garantido para ${para}, ${hora}. Vou adorar te receber! 🌸`],
    [oi, `Prontinho, seu horário está confirmado${sv ? `: ${sv}` : ""} ${em}, ${hora}. Se precisar remarcar, é só me chamar por aqui.`],
    [oiTudoBem, `Seu agendamento${sv ? ` de ${sv}` : ""} está confirmado para ${para}, ${hora}. Te espero com carinho! 💕`],
    [oi, `Só para confirmar: te espero ${em}, ${hora}${sv ? `, para ${sv}` : ""}. Até breve!`],
  ] as const)[variant];

  return `${greeting}\n\n${body}`;
}
