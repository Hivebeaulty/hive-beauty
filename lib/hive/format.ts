const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function formatMoney(value: number | null | undefined) {
  return currencyFormatter.format(value ?? 0);
}

export function greetingForHour(hour: number) {
  if (hour < 5) return "Boa noite";
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

export function firstName(fullName: string | null | undefined) {
  if (!fullName) return null;
  return fullName.trim().split(/\s+/)[0] || null;
}

// Só um link "abrir no WhatsApp do aparelho" — nenhuma automação. Assume
// Brasil (DDD + 8/9 dígitos) quando o número não já vem com código do país,
// já que é a realidade de uso da Áurea hoje.
export function whatsappLink(phone: string | null | undefined) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  return `https://wa.me/${withCountry}`;
}

// "Alongamento · R$ 120 · 2h" em vez de "120min" — duração é informação
// operacional (quanto da agenda o serviço ocupa), não só um número de form.
export function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}`;
}
