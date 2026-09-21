"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getPeriodRange, PERIOD_LABEL, type Period } from "@/lib/hive/period";

type Indicators = {
  atendimentos_realizados: number;
  faturado: number;
  recebido: number;
  despesas: number;
  resultado_caixa: number;
  pendente: number;
};

type PendingPayment = {
  id: string;
  description: string | null;
  amount: number;
  paid_amount: number | null;
  clients: { name: string } | null;
};

function money(v: number) {
  return `R$ ${v.toFixed(2)}`;
}

export default function FinanceiroPage() {
  const { companyId } = useCompany();
  const [period, setPeriod] = useState<Period>("mes");
  const [indicators, setIndicators] = useState<Indicators | null>(null);
  const [pending, setPending] = useState<PendingPayment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { start, end } = getPeriodRange(period);

    const [{ data: ind }, { data: pend }] = await Promise.all([
      supabase.rpc("get_period_indicators", { p_company_id: companyId, p_start: start, p_end: end }),
      supabase
        .from("payments")
        .select("id, description, amount, paid_amount, clients(name)")
        .eq("company_id", companyId)
        .in("status", ["pendente", "parcial"])
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    setIndicators((ind as unknown as Indicators[])?.[0] ?? null);
    setPending((pend as unknown as PendingPayment[]) ?? []);
    setLoading(false);
  }, [companyId, period]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-charcoal-900">Financeiro</h1>

      <div className="flex gap-2 overflow-x-auto">
        {(["hoje", "semana", "mes"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${
              period === p ? "bg-plum-500 text-white" : "bg-white text-charcoal-700"
            }`}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </div>

      {loading && <p className="text-center text-sm text-charcoal-500">Carregando...</p>}

      {!loading && indicators && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs text-charcoal-500">Entrou</p>
            <p className="text-xl font-bold text-success">{money(indicators.recebido)}</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs text-charcoal-500">Saiu</p>
            <p className="text-xl font-bold text-danger">{money(indicators.despesas)}</p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs text-charcoal-500">Resultado</p>
            <p className={`text-xl font-bold ${indicators.resultado_caixa >= 0 ? "text-charcoal-900" : "text-danger"}`}>
              {money(indicators.resultado_caixa)}
            </p>
          </div>
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs text-charcoal-500">Pendente</p>
            <p className="text-xl font-bold text-warning">{money(indicators.pendente)}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Link href="/financeiro/receitas" className="rounded-2xl bg-white p-4 text-center shadow-sm">
          <p className="font-semibold text-charcoal-900">Receitas</p>
          <p className="text-xs text-charcoal-500">Ver todas</p>
        </Link>
        <Link href="/financeiro/despesas" className="rounded-2xl bg-white p-4 text-center shadow-sm">
          <p className="font-semibold text-charcoal-900">Despesas</p>
          <p className="text-xs text-charcoal-500">Ver todas</p>
        </Link>
      </div>

      {pending.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-plum-500">
            Pagamentos pendentes
          </h2>
          <div className="space-y-2">
            {pending.map((p) => (
              <Link
                key={p.id}
                href={`/financeiro/receitas/${p.id}`}
                className="flex items-center justify-between rounded-xl bg-white p-3 shadow-sm"
              >
                <div>
                  <p className="text-sm font-medium text-charcoal-900">
                    {p.clients?.name ?? p.description ?? "Recebimento"}
                  </p>
                  <p className="text-xs text-charcoal-500">
                    Falta {money(Number(p.amount) - Number(p.paid_amount ?? 0))}
                  </p>
                </div>
                <span className="text-xs font-semibold text-warning">Pendente</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
