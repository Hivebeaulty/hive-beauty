// ---------------------------------------------------------------------------
// Central de comunicação — lógica PURA (sem React, sem Supabase).
//
// Nesta etapa nada é enviado. Este módulo só decide QUEM poderia receber e
// COMO a mensagem ficaria. Quando existir o serviço de WhatsApp, o frontend
// continua sendo só a "vitrine": o envio real será um pedido gravado no banco
// (RPC que descobre a empresa pela sessão e REVALIDA elegibilidade/consentimento
// no servidor) e consumido pelo worker. Nada aqui é confiável para segurança —
// é conveniência de tela.
// ---------------------------------------------------------------------------
import { firstName } from "./format";
import { isWhatsappCapable, phoneDisplay } from "./phone";

export type CommStatus = "unknown" | "allowed" | "blocked";

// Motivo pelo qual uma cliente NÃO seria alcançada. null = pode receber.
// A ordem de prioridade (de cima para baixo) é intencional: quem pediu para
// não receber é respeitada antes de qualquer outra coisa.
export type RecipientBlock =
  | "blocked"          // não quer receber mensagens
  | "no_phone"         // sem telefone cadastrado
  | "invalid_phone"    // telefone preenchido, mas inválido
  | "landline"         // telefone fixo (sem WhatsApp)
  | "consent_unknown"; // autorização não informada

export const BLOCK_LABEL: Record<RecipientBlock, string> = {
  blocked: "Não quer receber",
  no_phone: "Sem telefone",
  invalid_phone: "Telefone inválido",
  landline: "Telefone fixo",
  consent_unknown: "Autorização não informada",
};

export const COMM_STATUS_LABEL: Record<CommStatus, string> = {
  allowed: "Aceita mensagens",
  blocked: "Não quer receber",
  unknown: "Autorização não informada",
};

export type RecipientInput = {
  phone: string | null;
  phone_normalized: string | null;
  comm_status: CommStatus;
};

export function recipientBlock(c: RecipientInput): RecipientBlock | null {
  if (c.comm_status === "blocked") return "blocked";
  if (!c.phone || !c.phone.trim()) return "no_phone";
  if (!c.phone_normalized) return "invalid_phone";
  if (!isWhatsappCapable(c.phone_normalized)) return "landline";
  if (c.comm_status !== "allowed") return "consent_unknown";
  return null;
}

export type AudienceSummary = {
  total: number;
  reachable: number;
  blocked: number;
  noPhone: number;
  invalidPhone: number;
  landline: number;
  consentUnknown: number;
};

export function summarizeAudience(members: RecipientInput[]): AudienceSummary {
  const s: AudienceSummary = {
    total: members.length,
    reachable: 0,
    blocked: 0,
    noPhone: 0,
    invalidPhone: 0,
    landline: 0,
    consentUnknown: 0,
  };
  for (const m of members) {
    switch (recipientBlock(m)) {
      case null: s.reachable++; break;
      case "blocked": s.blocked++; break;
      case "no_phone": s.noPhone++; break;
      case "invalid_phone": s.invalidPhone++; break;
      case "landline": s.landline++; break;
      case "consent_unknown": s.consentUnknown++; break;
    }
  }
  return s;
}

export function displayPhone(c: Pick<RecipientInput, "phone" | "phone_normalized">): string | null {
  return phoneDisplay(c.phone, c.phone_normalized);
}

// --- Mensagem --------------------------------------------------------------

export const MAX_MESSAGE_LENGTH = 1000;

export const TEMPLATE_VARIABLES = [
  { key: "nome", label: "Nome da cliente" },
  { key: "negocio", label: "Nome do negócio" },
] as const;

const KNOWN_KEYS: Set<string> = new Set(TEMPLATE_VARIABLES.map((v) => v.key));

export type TemplateContext = { clientName: string; companyName: string };

// Troca {nome} e {negocio}. Variável desconhecida é mantida como está (e
// reportada por findUnknownVariables) — nunca some em silêncio.
export function renderTemplate(body: string, ctx: TemplateContext): string {
  const values: Record<string, string> = {
    nome: firstName(ctx.clientName) ?? ctx.clientName,
    negocio: ctx.companyName,
  };
  // Não diferencia maiúsculas: "{Nome}" também funciona, em vez de seguir
  // literalmente no texto sem nenhum aviso.
  return body.replace(/\{([A-Za-z_]+)\}/g, (match, key: string) => {
    const k = key.toLowerCase();
    return k in values ? values[k] : match;
  });
}

export function findUnknownVariables(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/\{([A-Za-z_]+)\}/g)) {
    if (!KNOWN_KEYS.has(m[1].toLowerCase())) found.add(m[1]);
  }
  return [...found];
}
