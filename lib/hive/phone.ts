// ---------------------------------------------------------------------------
// Telefone brasileiro — validação, normalização e formatação.
//
// ESPELHA a função SQL normalize_br_phone() da migration 0008. Se mudar uma
// regra aqui, mude lá também (o banco é a fonte da verdade do valor gravado em
// clients.phone_normalized; este arquivo serve para validar/formatar na tela
// ANTES de salvar e para detectar duplicidade em listas ainda não gravadas,
// como a importação).
//
// Forma normalizada: só dígitos, com DDI — "5511999990000" (celular, 13) ou
// "551132221234" (fixo, 12). Sem "+".
//
// Regra deliberada: celular com 8 dígitos (sem o 9) é INVÁLIDO, não é
// "consertado". Adivinhar o dígito pode mandar a mensagem para outra pessoa.
// ---------------------------------------------------------------------------

export type PhoneKind = "mobile" | "landline";

export type PhoneInvalidReason =
  | "empty"
  | "too_short"
  | "unsupported"
  | "invalid_ddd"
  | "missing_nine"
  | "invalid_format";

export type PhoneParse =
  | { ok: true; normalized: string; kind: PhoneKind; ddd: string; subscriber: string }
  | { ok: false; reason: PhoneInvalidReason; message: string };

const VALID_DDD = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99",
]);

function fail(reason: PhoneInvalidReason, message: string): PhoneParse {
  return { ok: false, reason, message };
}

export function parseBrazilPhone(raw: string | null | undefined): PhoneParse {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.length === 0) return fail("empty", "Informe o telefone.");

  // Prefixo internacional "00" e zero de tronco ("011 9...").
  if (d.startsWith("00")) d = d.slice(2);
  if ((d.length === 11 || d.length === 12) && d.startsWith("0")) d = d.slice(1);

  // Com código do país: 55 + 10/11 dígitos.
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);

  if (d.length < 10) return fail("too_short", "Faltam dígitos. Informe o DDD e o número.");
  if (d.length > 11) {
    return fail("unsupported", "Número com dígitos demais. Por enquanto só aceitamos números do Brasil.");
  }

  const ddd = d.slice(0, 2);
  const subscriber = d.slice(2);

  if (!VALID_DDD.has(ddd)) return fail("invalid_ddd", `O DDD ${ddd} não existe. Confira o número.`);

  if (subscriber.length === 9) {
    if (subscriber[0] !== "9") {
      return fail("invalid_format", "Celular com 9 dígitos precisa começar com 9.");
    }
    return { ok: true, normalized: `55${ddd}${subscriber}`, kind: "mobile", ddd, subscriber };
  }

  // 8 dígitos: fixo começa com 2-5. Começando com 6-9 era o celular antigo, sem
  // o 9 — pedimos correção em vez de adivinhar.
  if (/^[2-5]/.test(subscriber)) {
    return { ok: true, normalized: `55${ddd}${subscriber}`, kind: "landline", ddd, subscriber };
  }
  if (/^[6-9]/.test(subscriber)) {
    return fail("missing_nine", "Parece faltar o 9 na frente do celular. Confira o número.");
  }
  return fail("invalid_format", "Número inválido. Confira os dígitos.");
}

// "5511999990000" | null — mesmo resultado de clients.phone_normalized.
export function normalizeBrazilPhone(raw: string | null | undefined): string | null {
  const r = parseBrazilPhone(raw);
  return r.ok ? r.normalized : null;
}

// (11) 99999-0000 / (11) 3222-1234. Se o texto não for um número válido,
// devolve o texto original (nunca esconde o que a usuária digitou).
export function formatBrazilPhone(raw: string | null | undefined): string {
  const r = parseBrazilPhone(raw);
  if (!r.ok) return (raw ?? "").trim();
  const s = r.subscriber;
  const split = r.kind === "mobile" ? 5 : 4;
  return `(${r.ddd}) ${s.slice(0, split)}-${s.slice(split)}`;
}

// O que mostrar na tela: usa o valor normalizado do banco quando existe (então
// números antigos gravados como "11999990000" aparecem bonitos sem reescrever
// a coluna), senão tenta formatar o texto, senão mostra como está.
export function phoneDisplay(phone: string | null | undefined, normalized?: string | null): string | null {
  if (normalized) return formatBrazilPhone(normalized);
  if (!phone || !phone.trim()) return null;
  return formatBrazilPhone(phone);
}

// Celular normalizado (13 dígitos) é o único tipo que recebe WhatsApp.
export function isWhatsappCapable(normalized: string | null | undefined): boolean {
  return !!normalized && normalized.length === 13;
}

// Link "abrir conversa" (uso manual, 1 cliente por vez) — só para celular
// válido. Corrige o caso do DDD 55 (RS), que a regra antiga tratava como DDI.
export function whatsappChatLink(phone: string | null | undefined, normalized?: string | null): string | null {
  const n = normalized ?? normalizeBrazilPhone(phone);
  return isWhatsappCapable(n) ? `https://wa.me/${n}` : null;
}
