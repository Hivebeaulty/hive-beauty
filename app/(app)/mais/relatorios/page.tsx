"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getPeriodRange, periodBoundsISO, PERIOD_LABEL, type Period } from "@/lib/hive/period";
import { buildRankings, type ClientRank, type RankingRow, type ServiceRank } from "@/lib/hive/rankings";
import { Rankings } from "@/components/reports/rankings";
import { formatMoney } from "@/lib/hive/format";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ChevronLeft } from "lucide-react";

// Nomes de coluna EXATAMENTE como a RPC get_period_indicators devolve
// (migration 0006): faturado = total cobrado no período; recebido = o que já
// entrou; resultado_caixa = recebido - despesas. Dashboard, Financeiro e
// Relatórios leem os mesmos campos da mesma função — é isso que garante que
// os três mostrem números coerentes.
type Indicators = {
  atendimentos_realizados: number;
  faturado: number;
  recebido: number;
  despesas: number;
  resultado_caixa: number;
  pendente: number;
  cancelamentos: number;
  faltas: number;
  clientes_novas: number;
  clientes_recorrentes: number;
};

const CARDS: { key: keyof Indicators; label: string; money?: boolean }[] = [
  { key: "atendimentos_realizados", label: "Atendimentos realizados" },
  { key: "faturado", label: "Faturamento", money: true },
  { key: "recebido", label: "Recebido", money: true },
  { key: "despesas", label: "Despesas", money: true },
  { key: "resultado_caixa", label: "Resultado (recebido − despesas)", money: true },
  { key: "pendente", label: "Valores pendentes", money: true },
  { key: "cancelamentos", label: "Cancelamentos" },
  { key: "faltas", label: "Faltas" },
  { key: "clientes_novas", label: "Clientes novas" },
  { key: "clientes_recorrentes", label: "Clientes recorrentes" },
];

const PERIOD_OPTIONS: Period[] = ["hoje", "semana", "mes", "mes_anterior"];

export default function RelatoriosPage() {
  const { companyId } = useCompany();
  const [period, setPeriod] = useState<Period>("mes");
  const [data, setData] = useState<Indicators | null>(null);
  const [loading, setLoading] = useState(true);
  const [ranks, setRanks] = useState<{ services: ServiceRank[]; clients: ClientRank[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { start, end } = getPeriodRange(period);
    const { data: rows } = await supabase.rpc("get_period_indicators", {
      p_company_id: companyId,
      p_start: start,
      p_end: end,
    });
    setData((rows as unknown as Indicators[])?.[0] ?? null);

    // Rankings: atendimentos concluídos do período (mesma consulta do Financeiro),
    // lidos em páginas de 1000 para não cortar períodos longos.
    const bounds = periodBoundsISO(start, end);
    const all: RankingRow[] = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data: page, error } = await supabase
        .from("appointments")
        .select("id, scheduled_start, scheduled_end, price, client_id, service_id, clients(name), services(name)")
        .eq("company_id", companyId)
        .eq("status", "concluido")
        .gte("scheduled_start", bounds.from)
        .lte("scheduled_start", bounds.to)
        .order("scheduled_start")
        .range(from, from + 999);
      if (error || !page) break;
      all.push(...(page as unknown as RankingRow[]));
      if (page.length < 1000) break;
    }
    setRanks(buildRankings(all));
    setLoading(false);
  }, [companyId, period]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5 pb-4">
      <Link href="/mais" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Mais
      </Link>

      <h1 className="page-title">Relatórios</h1>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              period === p ? "bg-ink-800 text-cream" : "bg-ink-50 text-ink-600 hover:bg-ink-100"
            )}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-center text-sm text-ink-400">Carregando...</p>
      ) : data ? (
        <div className="grid grid-cols-2 gap-3">
          {CARDS.map((c) => (
            <Card key={c.key} padding="sm">
              <p className="text-xs text-ink-400">{c.label}</p>
              <p className="text-lg font-semibold text-ink-800">
                {c.money ? formatMoney(Number(data[c.key])) : Number(data[c.key])}
              </p>
            </Card>
          ))}
        </div>
      ) : null}

      {!loading && ranks && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink-700">Rankings do período</h2>
          <Rankings services={ranks.services} clients={ranks.clients} />
        </section>
      )}

      <p className="text-center text-xs text-ink-400">Resultados por profissional estão em Financeiro.</p>
    </div>
  );
}
