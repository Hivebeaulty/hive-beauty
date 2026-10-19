// ---------------------------------------------------------------------------
// Mensagens AUTOMÁTICAS por data (WhatsApp) — regras PURAS, com cópia IDÊNTICA no
// banco (migration 0035: whatsapp_private.auto_system_template / auto_render /
// auto_template_problems). Paridade em supabase/tests/local/0035_local.sh.
// Cada mensagem: liga/desliga por empresa; "sistema" (2 textos que alternam por
// ano) ou "própria" ({nome}, {negocio} e, no aniversário de cliente, {anos}).
// ---------------------------------------------------------------------------
import { normalizeVariable } from "./message-template";

export type AutoKind = "new_year" | "womens_day" | "selfcare_day" | "customer_day" | "christmas" | "client_anniversary";

export const AUTO_MESSAGES: { kind: AutoKind; title: string; when: string; vars: string[] }[] = [
  { kind: "new_year", title: "Ano-Novo", when: "01/01", vars: ["nome", "negocio"] },
  { kind: "womens_day", title: "Dia da Mulher", when: "08/03", vars: ["nome", "negocio"] },
  { kind: "selfcare_day", title: "Dia do Autocuidado", when: "24/07", vars: ["nome", "negocio"] },
  { kind: "customer_day", title: "Dia do Cliente", when: "15/09", vars: ["nome", "negocio"] },
  { kind: "christmas", title: "Natal", when: "25/12", vars: ["nome", "negocio"] },
  { kind: "client_anniversary", title: "Aniversário de cliente", when: "No dia do primeiro atendimento", vars: ["nome", "negocio", "anos"] },
];

export const AUTO_SYSTEM_TEMPLATES: Record<AutoKind, [string, string]> = {
  new_year: [
    "Feliz Ano-Novo, {nome}! Que o novo ano venha cheio de saúde, alegria e conquistas. Obrigada por estar comigo! ✨",
    "Oi, {nome}! Feliz Ano-Novo! Desejo um ano leve, com muito carinho e motivos para sorrir. 🥂",
  ],
  womens_day: [
    "Feliz Dia da Mulher, {nome}! Que você continue se cuidando e brilhando do seu jeito. 🌸",
    "Oi, {nome}! Hoje é o seu dia: feliz Dia da Mulher! Que nunca falte força, leveza e tempo para você. 💕",
  ],
  selfcare_day: [
    "Oi, {nome}! Hoje é o Dia do Autocuidado, um lembrete carinhoso para separar um tempinho só para você. Você merece! ✨",
    "Feliz Dia do Autocuidado, {nome}! Cuidar de si é um gesto de amor. Quando quiser, estou aqui para esse momento. 🌿",
  ],
  customer_day: [
    "Feliz Dia do Cliente, {nome}! Obrigada pela confiança e por fazer parte da minha história. É um prazer te atender. 💛",
    "Oi, {nome}! Hoje é Dia do Cliente e eu não poderia deixar de agradecer pelo carinho e pela confiança de sempre.",
  ],
  christmas: [
    "Feliz Natal, {nome}! Que sua noite seja cheia de paz, amor e boas lembranças. Obrigada por estar comigo neste ano. 🎄",
    "Oi, {nome}! Desejo um Natal lindo, com muita luz e carinho ao lado de quem você ama. Feliz Natal! ✨",
  ],
  client_anniversary: [
    "Oi, {nome}! Hoje faz {anos} que você confia em mim para se cuidar. Obrigada por cada visita! 💕",
    "Feliz aniversário de parceria, {nome}! Hoje faz {anos} desde o seu primeiro atendimento comigo. Obrigada pelo carinho de sempre! ✨",
  ],
};

export const AUTO_TEMPLATE_MAX = 1000;

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

export function autoVariant(clientId: string, kind: AutoKind, year: number): 0 | 1 {
  return (hash(`${clientId}:${kind}:${year}`) % 2) as 0 | 1;
}

export function yearsLabel(n: number): string {
  return n === 1 ? "1 ano" : `${n} anos`;
}

/** Troca as variáveis e limpa a pontuação (nome vazio não deixa ", !"). Igual ao banco. */
export function renderAuto(template: string, v: { name?: string | null; business?: string | null; years?: number | null }): string {
  const nome = (v.name ?? "").trim().split(/\s+/)[0] ?? "";
  const values: Record<string, string> = { nome, negocio: (v.business ?? "").trim(), anos: v.years ? yearsLabel(v.years) : "" };
  let t = template.replace(/\r\n?/g, "\n");
  t = t.replace(/\{([^{}\s]{1,30})\}/g, (m, k: string) => {
    const key = normalizeVariable(k);
    return key in values ? values[key] : m;
  });
  t = t.replace(/[ \t]+([,.!?;:])/g, "$1");
  t = t.replace(/,([!?.])/g, "$1");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+(\n|$)/g, "$1");
  return t.trim();
}

export function autoTemplateProblems(kind: AutoKind, template: string | null | undefined): string[] {
  const t = (template ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) return ["Escreva a mensagem."];
  const problems: string[] = [];
  if (t.length > AUTO_TEMPLATE_MAX) problems.push(`A mensagem passou de ${AUTO_TEMPLATE_MAX} caracteres.`);
  const allowed = new Set(AUTO_MESSAGES.find((m) => m.kind === kind)?.vars ?? []);
  const unknown = new Set<string>();
  for (const m of t.matchAll(/\{([^{}\s]{1,30})\}/g)) if (!allowed.has(normalizeVariable(m[1]))) unknown.add(`{${m[1]}}`);
  if (unknown.size) problems.push(`Variável desconhecida: ${[...unknown].join(", ")}.`);
  return problems;
}

/** O texto que sai: própria (se válida) ou a do sistema da vez. */
export function buildAutoMessage(i: {
  kind: AutoKind; mode: "system" | "custom"; template?: string | null;
  clientId: string; year: number; name?: string | null; business?: string | null; years?: number | null;
}): string {
  const tpl = i.mode === "custom" && i.template && autoTemplateProblems(i.kind, i.template).length === 0
    ? i.template
    : AUTO_SYSTEM_TEMPLATES[i.kind][autoVariant(i.clientId, i.kind, i.year)];
  return renderAuto(tpl, { name: i.name, business: i.business, years: i.years });
}
