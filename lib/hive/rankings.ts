// Relatórios — rankings de serviços e clientes (lógica PURA).
// Base: atendimentos CONCLUÍDOS no período (mesma consulta do Financeiro).
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
    const s = sv.get(r.service_id) ?? { id: r.service_id, name: one(r.services)?.name ?? "Serviço", count: 0, revenue: 0, minutes: 0, avgTicket: 0, revenuePerHour: 0 };
    s.count += 1; s.revenue += value; s.minutes += minutes;
    sv.set(r.service_id, s);
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
