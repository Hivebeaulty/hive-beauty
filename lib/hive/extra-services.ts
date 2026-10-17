// ---------------------------------------------------------------------------
// Vários serviços no mesmo atendimento (migration 0033) — regras PURAS.
// O atendimento tem o serviço PRINCIPAL e até 10 ADICIONAIS; valor e duração do
// atendimento = soma. A lista de nomes é a mesma do banco
// (whatsapp_private.appointment_services_label): "A", "A e B", "A, B e C".
// ---------------------------------------------------------------------------

export const MAX_EXTRA_SERVICES = 10;

export type ExtraItem = { service_id: string; price: number; duration_minutes: number };

/** Valor e duração totais do atendimento. */
export function totals(primary: { price: number; minutes: number }, extras: ExtraItem[]) {
  return {
    price: Math.round((Number(primary.price) + extras.reduce((s, e) => s + Number(e.price), 0)) * 100) / 100,
    minutes: primary.minutes + extras.reduce((s, e) => s + e.duration_minutes, 0),
  };
}

/** "Manicure", "Manicure e Pedicure", "Manicure, Pedicure e Esmaltação" (igual ao banco). */
export function servicesLabel(names: (string | null | undefined)[]): string {
  const n = names.map((x) => (x ?? "").trim()).filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} e ${n[n.length - 1]}`;
}

/** Itens válidos para gravar (o banco confere de novo). */
export function extraItemsProblem(extras: ExtraItem[]): string | null {
  if (extras.length > MAX_EXTRA_SERVICES) return `No máximo ${MAX_EXTRA_SERVICES} serviços adicionais.`;
  for (const e of extras) {
    if (!e.service_id) return "Escolha o serviço adicional.";
    if (!(Number(e.price) >= 0)) return "Valor inválido em um dos serviços.";
    if (!(e.duration_minutes >= 1)) return "Duração inválida em um dos serviços.";
  }
  return null;
}

/** As listas são iguais? (para não gravar sem mudança) */
export function sameExtras(a: ExtraItem[], b: ExtraItem[]): boolean {
  return a.length === b.length && a.every((x, i) =>
    x.service_id === b[i].service_id && Number(x.price) === Number(b[i].price) && x.duration_minutes === b[i].duration_minutes);
}

/**
 * Relatórios: quanto do valor do atendimento é de cada serviço. Os adicionais
 * valem o valor deles; o principal fica com o restante (nunca negativo).
 */
export function splitRevenue(total: number, extras: { price: number | string }[]): { primary: number; extras: number[] } {
  const ex = extras.map((e) => Math.max(0, Number(e.price) || 0));
  const primary = Math.max(0, Math.round((Number(total) - ex.reduce((s, x) => s + x, 0)) * 100) / 100);
  return { primary, extras: ex };
}
