// "Como você quer ser chamada?" — nome de exibição (profiles.display_name).
// NUNCA substitui o nome cadastrado: é só como o app e as mensagens chamam a
// pessoa. Vazio = cai no nome cadastrado, como sempre foi.
import { firstName } from "./format";

export const DISPLAY_NAME_MAX = 40; // mesmo limite do CHECK da migration 0013

// Normaliza o que foi digitado: espaços colapsados, corta no limite, vazio = null.
export function normalizeDisplayNameInput(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX).trim();
  return v.length > 0 ? v : null;
}

// Saudação da tela inicial. Ordem: nome de exibição (como foi digitado) >
// 1º nome do perfil > 1º nome do metadado do login (comportamento anterior).
export function resolveGreetingName(i: {
  displayName?: string | null;
  profileFullName?: string | null;
  metadataFullName?: string | null;
}): string | null {
  const preferred = normalizeDisplayNameInput(i.displayName);
  if (preferred) return preferred;
  return firstName(i.profileFullName) ?? firstName(i.metadataFullName) ?? null;
}

// Assinatura de mensagens para a profissional de um atendimento.
export function resolveSignatureName(i: { displayName?: string | null; fullName?: string | null }): string | null {
  return normalizeDisplayNameInput(i.displayName) ?? firstName(i.fullName) ?? null;
}
