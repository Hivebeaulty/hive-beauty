// ---------------------------------------------------------------------------
// Mensagem de CONFIRMAÇÃO personalizada pela profissional (opção 2).
//
// Lógica PURA, com cópia IDÊNTICA no banco (whatsapp_private.custom_confirmation_text
// e whatsapp_private.template_problems, migration 0027) — teste de paridade em
// supabase/tests/local/0018_message_parity.cjs.
//
// Variáveis: {nome} {negocio} {servico} {data} {dia_semana} {horario}
//   - maiúsculas e acentos não importam: {Nome}, {serviço}, {horário} valem;
//   - variável desconhecida NUNCA é enviada: o texto é recusado ao salvar;
//   - {data} e {horario} são obrigatórias (é uma confirmação de horário).
// Sem nome/serviço cadastrado, a variável some e a pontuação é arrumada
// ("Olá {nome}!" → "Olá!", nunca "Olá !").
// ---------------------------------------------------------------------------

export const CONFIRMATION_TEMPLATE_MAX = 1000;

export const CONFIRMATION_VARIABLES = [
  { key: "nome", label: "Nome da cliente", example: "Ana" },
  { key: "servico", label: "Serviço", example: "Manicure" },
  { key: "data", label: "Data", example: "16/10" },
  { key: "dia_semana", label: "Dia da semana", example: "sexta-feira" },
  { key: "horario", label: "Horário", example: "14h30" },
  { key: "negocio", label: "Nome do negócio", example: "Studio Bella" },
] as const;

export const DEFAULT_CUSTOM_TEMPLATE =
  "Olá, {nome}! Seu agendamento de {servico} está confirmado para {dia_semana}, {data}, às {horario}.\n\nPara remarcações, o prazo mínimo é de 24h.\n\nObrigada!";

const TOKEN = /\{([^{}\s]{1,30})\}/g;
const KNOWN = new Set<string>(CONFIRMATION_VARIABLES.map((v) => v.key));

/** {Serviço} → servico ; {HORÁRIO} → horario (mesma regra do banco: translate). */
export function normalizeVariable(raw: string): string {
  const from = "áàâãäéèêëíìîïóòôõöúùûüç";
  const to = "aaaaaeeeeiiiiooooouuuuc";
  let out = "";
  for (const ch of raw.toLowerCase()) {
    const i = from.indexOf(ch);
    out += i >= 0 ? to[i] : ch;
  }
  return out;
}

const normalizeText = (t: string) => t.replace(/\r\n?/g, "\n");

/** Problemas que impedem salvar (vazio = pode salvar). Mesmas mensagens do banco. */
export function confirmationTemplateProblems(template: string | null | undefined): string[] {
  const t = normalizeText(template ?? "").trim();
  if (!t) return ["Escreva a mensagem."];
  const problems: string[] = [];
  if (t.length > CONFIRMATION_TEMPLATE_MAX) problems.push(`A mensagem passou de ${CONFIRMATION_TEMPLATE_MAX} caracteres.`);
  const unknown = new Set<string>();
  const used = new Set<string>();
  for (const m of t.matchAll(TOKEN)) {
    const k = normalizeVariable(m[1]);
    if (KNOWN.has(k)) used.add(k);
    else unknown.add(`{${m[1]}}`);
  }
  if (unknown.size) problems.push(`Variável desconhecida: ${[...unknown].join(", ")}.`);
  if (!used.has("data") || !used.has("horario")) problems.push("Inclua {data} e {horario} na mensagem.");
  return problems;
}

export type TemplateValues = {
  nome: string;
  negocio: string;
  servico: string;
  data: string;
  dia_semana: string;
  horario: string;
};

export function renderConfirmationTemplate(template: string, v: TemplateValues): string {
  const values: Record<string, string> = v;
  let t = normalizeText(template).replace(TOKEN, (match, key: string) => {
    const k = normalizeVariable(key);
    return k in values ? values[k] : match;
  });
  t = t.replace(/[ \t]+([,.!?;:])/g, "$1");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+(\n|$)/g, "$1");
  return t.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}
