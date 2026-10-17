// Relatórios — rankings de serviços e clientes (lógica PURA).
// Base: atendimentos CONCLUÍDOS no período (mesma consulta do Financeiro).
// Vários serviços no atendimento (0033): cada adicional conta no próprio serviço
// com o valor dele; o principal fica com o restante. O total da cliente não muda.
// Valor de cada atendimento = o preço gravado nele — a conclusão grava ali o
// VALOR FINAL (conclude_appointment). É a mesma base da lista "Por serviço" do
// Financeiro, então os números das duas telas batem. Nada é estimado.

export type RankingRow = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  price: number | string | null;
  client_id: string;
  service_id: string;
  clients: { name: string } | { name: string }[] | null;
  services: { name: string } | { name: string }[] | null;
  /** Serviços adicionais (0033): cada um conta no próprio serviço, com o valor dele. */
  appointment_extra_services?: {
    service_id: string;
    price: number | string;
    duration_minutes: number;
    services: { name: string } | { name: string }[] | null;
  }[] | null;
};

export type ServiceRank = { id: string; name: string; count: number; revenue: number; minutes: number; avgTicket: number; revenuePerHour: number };
export type ClientRank = { id: string; name: string; visits: number; revenue: number; lastVisit: string };

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
const cents = (n: number) => Math.round(n * 100) / 100;

export function appointmentValue(r: RankingRow): number {
  const v = Number(r.price ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export function buildRankings(rows: RankingRow[]): { services: ServiceRank[]; clients: ClientRank[] } {
  const sv = new Map<string, ServiceRank>();
  const cl = new Map<string, ClientRank>();
  for (const r of rows) {
    const value = appointmentValue(r);
    const minutes = Math.max(0, (new Date(r.scheduled_end).getTime() - new Date(r.scheduled_start).getTime()) / 60000);
    // principal fica com o restante do valor/tempo; cada adicional, com o dele
    const ex = r.appointment_extra_services ?? [];
    const exValues = ex.map((e) => Math.max(0, Number(e.price) || 0));
    const exMinutes = ex.reduce((t, e) => t + Math.max(0, e.duration_minutes || 0), 0);
    const add = (id: string, name: string | undefined, rev: number, min: number) => {
      const s = sv.get(id) ?? { id, name: name ?? "Serviço", count: 0, revenue: 0, minutes: 0, avgTicket: 0, revenuePerHour: 0 };
      s.count += 1; s.revenue += rev; s.minutes += min;
      sv.set(id, s);
    };
    add(r.service_id, one(r.services)?.name, Math.max(0, value - exValues.reduce((t, x) => t + x, 0)), Math.max(0, minutes - exMinutes));
    ex.forEach((e, i) => add(e.service_id, one(e.services)?.name, exValues[i], Math.max(0, e.duration_minutes || 0)));
    const c = cl.get(r.client_id) ?? { id: r.client_id, name: one(r.clients)?.name ?? "Cliente", visits: 0, revenue: 0, lastVisit: r.scheduled_start };
    c.visits += 1; c.revenue += value;
    if (r.scheduled_start > c.lastVisit) c.lastVisit = r.scheduled_start;
    cl.set(r.client_id, c);
  }
  const services = [...sv.values()].map((s) => ({
    ...s,
    revenue: cents(s.revenue),
    avgTicket: s.count ? cents(s.revenue / s.count) : 0,
    revenuePerHour: s.minutes > 0 ? cents(s.revenue / (s.minutes / 60)) : 0,
  }));
  const clients = [...cl.values()].map((c) => ({ ...c, revenue: cents(c.revenue) }));
  return { services, clients };
}

/** Top N por um critério, com desempate estável (nome). */
export function topBy<T extends { name: string }>(list: T[], key: keyof T, n = 5): T[] {
  return [...list].sort((a, b) => Number(b[key]) - Number(a[key]) || a.name.localeCompare(b.name, "pt-BR")).slice(0, n);
}
