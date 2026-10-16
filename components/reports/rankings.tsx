// Rankings do período (relatórios). Só apresentação: os números vêm de
// buildRankings (lib/hive/rankings.ts), sobre os atendimentos concluídos.
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/hive/format";
import { topBy, type ClientRank, type ServiceRank } from "@/lib/hive/rankings";

type Item = { id: string; name: string; value: number; main: string; detail?: string };

function RankList({ title, hint, items, testid }: { title: string; hint?: string; items: Item[]; testid: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <Card data-testid={testid}>
      <h2 className="text-sm font-semibold text-ink-800">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
      <ol className="mt-3 space-y-3">
        {items.map((it, idx) => (
          <li key={it.id} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 truncate text-sm text-ink-800">
                <span className="mr-1.5 font-serif tabular-nums text-ink-400">{idx + 1}.</span>
                {it.name}
              </p>
              <p className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-ink-800">{it.main}</p>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sand" aria-hidden="true">
              <div className="h-full rounded-full bg-gold-500" style={{ width: `${Math.max(4, (it.value / max) * 100)}%` }} />
            </div>
            {it.detail && <p className="mt-0.5 text-[11px] text-ink-400">{it.detail}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

const plural = (n: number, s: string, p: string) => `${n} ${n === 1 ? s : p}`;
const dateBR = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

export function Rankings({ services, clients }: { services: ServiceRank[]; clients: ClientRank[] }) {
  if (services.length === 0) {
    return <p className="text-center text-sm text-ink-400">Nenhum atendimento concluído neste período para montar os rankings.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <RankList
        testid="rank-servicos-realizados"
        title="Serviços mais realizados"
        items={topBy(services, "count").map((s) => ({
          id: s.id, name: s.name, value: s.count, main: plural(s.count, "atendimento", "atendimentos"),
        }))}
      />
      <RankList
        testid="rank-servicos-faturamento"
        title="Serviços que mais faturam"
        hint="Por hora: quanto o serviço fatura por hora de agenda ocupada."
        items={topBy(services, "revenue").map((s) => ({
          id: s.id, name: s.name, value: s.revenue, main: formatMoney(s.revenue),
          detail: `média ${formatMoney(s.avgTicket)} · ${formatMoney(s.revenuePerHour)} por hora`,
        }))}
      />
      <RankList
        testid="rank-clientes-gasto"
        title="Clientes que mais gastam"
        items={topBy(clients, "revenue").map((c) => ({
          id: c.id, name: c.name, value: c.revenue, main: formatMoney(c.revenue), detail: plural(c.visits, "visita", "visitas"),
        }))}
      />
      <RankList
        testid="rank-clientes-frequencia"
        title="Clientes mais frequentes"
        items={topBy(clients, "visits").map((c) => ({
          id: c.id, name: c.name, value: c.visits, main: plural(c.visits, "visita", "visitas"), detail: `última em ${dateBR(c.lastVisit)}`,
        }))}
      />
    </div>
  );
}
