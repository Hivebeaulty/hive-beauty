"use client";

import { useEffect, useState, useCallback } from "react";
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
  cancelamentos: number;
  faltas: number;
  clientes_novas: number;
  clientes_recorrentes: number;
};

const CARDS: { key: keyof Indicators; label: string; format: (v: number) => string }[] = [
  { key: "atendimentos_realizados", label: "Atendimentos realizados", format: (v) => String(v) },
  { key: "faturado", label: "Faturado (gerado)", format: (v) => `R$ ${v.toFixed(2)}` },
  { key: "recebido", label: "Recebido (caixa)", format: (v) => `R$ ${v.toFixed(2)}` },
  { key: "despesas", label: "Despesas", format: (v) => `R$ ${v.toFixed(2)}` },
  { key: "resultado_caixa", label: "Resultado de caixa", format: (v) => `R$ ${v.toFixed(2)}` },
  { key: "pendente", label: "Valores pendentes", format: (v) => `R$ ${v.toFixed(2)}` },
  { key: "cancelamentos", label: "Cancelamentos", format: (v) => String(v) },
  { key: "faltas", label: "Faltas", format: (v) => String(v) },
  { key: "clientes_novas", label: "Clientes novas", format: (v) => String(v) },
  { key: "clientes_recorrentes", label: "Clientes recorrentes", format: (v) => String(v) },
];

export default function RelatoriosPage() {
  const { companyId } = useCompany();
  const [period, setPeriod] = useState<Period>("mes");
  const [data, setData] = useState<Indicators | null>(null);
  const [loading, setLoading] = useState(true);

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
    setLoading(false);
  }, [companyId, period]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-charcoal-900">Relatórios</h1>

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

      {!loading && data && (
        <div className="grid grid-cols-2 gap-3">
          {CARDS.map((c) => (
            <div key={c.key} className="rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-xs text-charcoal-500">{c.label}</p>
              <p className="text-lg font-bold text-charcoal-900">{c.format(Number(data[c.key]))}</p>
            </div>
          ))}
        </div>
      )}

      <p className="text-center text-xs text-charcoal-500">
        Estes indicadores entram no Início (visão geral) na próxima fase.
      </p>
    </div>
  );
}
