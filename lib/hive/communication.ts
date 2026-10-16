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

// --- Envio pelo WhatsApp (migrations 0028/0029) --------------------------------
// O texto enviado é EXATAMENTE a mensagem da profissional (com {nome}/{negocio}
// trocados) — nenhum rodapé é acrescentado. Mesma regra no banco
// (whatsapp_private.campaign_text): a prévia é exatamente o que sai.
// O bloqueio de quem responde SAIR/PARAR/STOP continua valendo (record_inbound).
export function campaignMessage(body: string, ctx: TemplateContext): string {
  return renderTemplate(body.trim(), ctx);
}

// Por que o botão está desligado (null = pode enviar).
export function sendBlockReason(canManage: boolean, waReady: boolean | null, selected: number, message: string, unknown: number): string | null {
  if (!canManage) return "Só a administração do negócio pode enviar mensagens pela central.";
  if (waReady === null) return "Verificando a conexão do WhatsApp...";
  if (!waReady) return "Conecte o WhatsApp em Mais → Configurações → WhatsApp para enviar daqui.";
  if (selected === 0) return "Selecione pelo menos uma cliente.";
  if (!message.trim()) return "Escreva a mensagem.";
  if (unknown > 0) return "Corrija as variáveis desconhecidas na mensagem.";
  if (message.length > MAX_MESSAGE_LENGTH) return `A mensagem passou de ${MAX_MESSAGE_LENGTH} caracteres.`;
  return null;
}

export function campaignErrorMessage(code: string | undefined, message: string): string {
  switch (code) {
    case "AUW01":
      return "O WhatsApp do negócio não está conectado. Nada foi enviado.";
    case "AUW02":
      return "Nenhuma das clientes selecionadas pode receber agora. Nada foi enviado.";
    case "AUW03":
    case "AUW05":
    case "AUW06":
      return `${message} Nada foi enviado.`;
    case "42501":
      return "Só a administração do negócio pode enviar mensagens pela central.";
    default:
      return "Não foi possível iniciar o envio. Nada foi enviado; tente novamente.";
  }
}

