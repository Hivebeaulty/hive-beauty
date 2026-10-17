// ---------------------------------------------------------------------------
// Mensagem de ANIVERSÁRIO (WhatsApp) — regras PURAS, com cópia IDÊNTICA no
// banco (migration 0031: whatsapp_private.birthday_system_text,
// birthday_custom_text e birthday_template_problems). Teste de paridade em
// supabase/tests/local/0031_local.sh.
//
// Opção 1 (sistema): 6 mensagens variadas, no singular, emoji ocasional.
// Opção 2 (própria): texto da profissional com {nome} e {negocio}.
// Variação escolhida por cliente + ano: a mesma cliente não recebe sempre a
// mesma frase, e um reenvio no mesmo ano gera exatamente o mesmo texto.
// ---------------------------------------------------------------------------
import { firstName } from "./format";
import { normalizeVariable, renderConfirmationTemplate } from "./message-template";

export const BIRTHDAY_TEMPLATE_MAX = 1000;

export const BIRTHDAY_VARIABLES = [
  { key: "nome", label: "Nome da cliente", example: "Ana" },
  { key: "negocio", label: "Nome do negócio", example: "Studio Bella" },
] as const;

export const DEFAULT_BIRTHDAY_TEMPLATE = "Feliz aniversário, {nome}! Desejo um novo ano cheio de alegria e momentos especiais. Um beijo!";

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

export function birthdayVariant(clientId: string, year: number): number {
  return hash(`${clientId}:${year}`) % 6;
}

/** Opção 1: mensagens variadas do sistema. */
export function buildBirthdaySystemMessage(clientName: string | null | undefined, clientId: string, year: number): string {
  const n = firstName(clientName ?? "") ?? "";
  switch (birthdayVariant(clientId, year)) {
    case 0:
      return `Feliz aniversário${n ? `, ${n}` : ""}! 🎉 Que seu novo ciclo venha cheio de alegria, saúde e muitos motivos para sorrir.`;
    case 1:
      return `Oi${n ? `, ${n}` : ""}! Hoje o dia é seu: feliz aniversário! Desejo um ano lindo, com muito carinho e realizações. 💕`;
    case 2:
      return `${n ? `${n}, feliz` : "Feliz"} aniversário! Que hoje seja especial do começo ao fim. Um abraço carinhoso!`;
    case 3:
      return `Parabéns${n ? `, ${n}` : ""}! 🎂 Desejo que este novo ano traga tudo de bom para você.`;
    case 4:
      return `Oi${n ? `, ${n}` : ""}! Passando para te desejar um feliz aniversário, com muita saúde, paz e momentos felizes. ✨`;
    default:
      return `Feliz aniversário${n ? `, ${n}` : ""}! Que a vida te presenteie com dias leves e muita alegria. Um beijo!`;
  }
}

const TOKEN = /\{([^{}\s]{1,30})\}/g;
const KNOWN = new Set<string>(BIRTHDAY_VARIABLES.map((v) => v.key));

/** Problemas que impedem salvar a mensagem própria. Mesmas frases do banco. */
export function birthdayTemplateProblems(template: string | null | undefined): string[] {
  const t = (template ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) return ["Escreva a mensagem."];
  const problems: string[] = [];
  if (t.length > BIRTHDAY_TEMPLATE_MAX) problems.push(`A mensagem passou de ${BIRTHDAY_TEMPLATE_MAX} caracteres.`);
  const unknown = new Set<string>();
  for (const m of t.matchAll(TOKEN)) if (!KNOWN.has(normalizeVariable(m[1]))) unknown.add(`{${m[1]}}`);
  if (unknown.size) problems.push(`Variável desconhecida: ${[...unknown].join(", ")}.`);
  return problems;
}

/** Opção 2: a mensagem própria com as variáveis trocadas (mesma limpeza da confirmação). */
export function renderBirthdayTemplate(template: string, clientName: string | null | undefined, businessName: string | null | undefined): string {
  return renderConfirmationTemplate(template, {
    nome: firstName(clientName ?? "") ?? "",
    negocio: (businessName ?? "").trim(),
    servico: "",
    data: "",
    dia_semana: "",
    horario: "",
  });
}

/** O texto que sai: própria (se válida) ou do sistema. */
export function buildBirthdayMessage(i: {
  mode: "system" | "custom";
  template?: string | null;
  clientName: string | null | undefined;
  businessName?: string | null;
  clientId: string;
  year: number;
}): string {
  if (i.mode === "custom" && i.template && birthdayTemplateProblems(i.template).length === 0) {
    return renderBirthdayTemplate(i.template, i.clientName, i.businessName);
  }
  return buildBirthdaySystemMessage(i.clientName, i.clientId, i.year);
}
