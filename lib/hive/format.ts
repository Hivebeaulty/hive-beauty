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
