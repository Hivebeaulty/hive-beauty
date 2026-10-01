"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getPeriodRange, periodBoundsISO, PERIOD_LABEL, type Period } from "@/lib/hive/period";
import { expenseEffectiveDate, isWithinPeriod } from "@/lib/hive/finance";
import { formatMoney } from "@/lib/hive/format";
import { getActiveProfessionals, type Professional } from "@/lib/hive/schedule";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Plus, Receipt, TrendingDown, ArrowRight } from "lucide-react";

type Indicators = {
  atendimentos_realizados: number;
  faturado: number;
  recebido: number;
  despesas: number;
  resultado_caixa: number;
  pendente: number;
};

type ExpenseRow = {
  id: string;
  description: string;
  amount: number;
  paid_at: string | null;
  due_date: string | null;
  created_at: string;
};

type ApptRow = {
  price: number;
  professional_member_id: string;
  services: { name: string } | { name: string }[] | null;
};

type PendingPayment = {
  id: string;
  description: string | null;
  amount: number;
  paid_amount: number | null;
  clients: { name: string } | null;
};

const PERIOD_OPTIONS: Period[] = ["hoje", "semana", "mes", "mes_anterior", "personalizado"];

function serviceName(s: ApptRow["services"]) {
  return Array.isArray(s) ? s[0]?.name : s?.name;
}

export function FinanceiroContent() {
  const { companyId } = useCompany();
  const [period, setPeriod] = useState<Period>("mes");
  const [customStart, setCustomStart] = useState(getPeriodRange("mes").start);
  const [customEnd, setCustomEnd] = useState(getPeriodRange("mes").end);
  const [loading, setLoading] = useState(true);

  const [indicators, setIndicators] = useState<Indicators | null>(null);
  const [expenseCount, setExpenseCount] = useState(0);
  const [byService, setByService] = useState<{ name: string; count: number; total: number }[]>([]);
  const [byProfessional, setByProfessional] = useState<{ name: string; count: number; total: number }[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [pending, setPending] = useState<PendingPayment[]>([]);

  const range = period === "personalizado" ? { start: customStart, end: customEnd } : getPeriodRange(period);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { start, end } = range;
    const bounds = periodBoundsISO(start, end);

    const [{ data: ind }, { data: expenses }, { data: appts }, profs, { data: pend }] =
      await Promise.all([
        supabase.rpc("get_period_indicators", { p_company_id: companyId, p_start: start, p_end: end }),
        // Todas as despesas — filtro por data efetiva (paid_at > due_date >
        // created_at) é feito em JS, replicando a mesma regra da RPC.
        supabase.from("expenses").select("id, description, amount, paid_at, due_date, created_at").eq("company_id", companyId).order("created_at", { ascending: false }).limit(1000),
        supabase
          .from("appointments")
          .select("price, professional_member_id, services(name)")
          .eq("company_id", companyId)
          .eq("status", "concluido")
          .gte("scheduled_start", bounds.from)
          .lte("scheduled_start", bounds.to),
        getActiveProfessionals(supabase, companyId),
        supabase
          .from("payments")
          .select("id, description, amount, paid_amount, clients(name)")
          .eq("company_id", companyId)
          .in("status", ["pendente", "parcial"])
          .order("created_at", { ascending: false })
          .limit(6),
      ]);

    setIndicators((ind as unknown as Indicators[])?.[0] ?? null);

    const expensesInPeriod = ((expenses as ExpenseRow[]) ?? []).filter((e) =>
      isWithinPeriod(expenseEffectiveDate(e), start, end)
    );
    setExpenseCount(expensesInPeriod.length);

    const apptRows = (appts as unknown as ApptRow[]) ?? [];
    const svcMap = new Map<string, { count: number; total: number }>();
    for (const a of apptRows) {
      const name = serviceName(a.services) ?? "Sem serviço";
      const cur = svcMap.get(name) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number(a.price);
      svcMap.set(name, cur);
    }
    setByService([...svcMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.total - a.total));

    setProfessionals(profs);
    const profMap = new Map<string, { count: number; total: number }>();
    for (const a of apptRows) {
      const cur = profMap.get(a.professional_member_id) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number(a.price);
      profMap.set(a.professional_member_id, cur);
    }
    setByProfessional(
      profs
        .map((p) => ({ name: p.name, ...(profMap.get(p.id) ?? { count: 0, total: 0 }) }))
        .filter((p) => p.count > 0)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    );

    setPending((pend as unknown as PendingPayment[]) ?? []);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, period, customStart, customEnd]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Financeiro"
        actions={
          <Link href="/financeiro/receitas/novo">
            <Button size="sm">
              <Plus className="size-4" />
              Recebimento
            </Button>
          </Link>
        }
      />

      {/* Período ------------------------------------------------------- */}
      <div>
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
        {period === "personalizado" && (
          <div className="mt-3 flex items-center gap-2">
            <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            <span className="text-ink-300">–</span>
            <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          {/* Receita ------------------------------------------------- */}
          <Card>
            <h2 className="mb-1 text-sm font-semibold text-ink-700">Receita</h2>
            <p className="mb-4 text-xs text-ink-400">
              Faturamento é o que foi cobrado; recebido é o que já entrou; pendente é o que falta receber.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-lg font-semibold text-ink-800 sm:text-xl">{formatMoney(indicators?.faturado)}</p>
                <p className="text-xs text-ink-400">Faturamento</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success sm:text-xl">{formatMoney(indicators?.recebido)}</p>
                <p className="text-xs text-ink-400">Recebido</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-warning sm:text-xl">{formatMoney(indicators?.pendente)}</p>
                <p className="text-xs text-ink-400">Pendente</p>
              </div>
            </div>
          </Card>

          {/* Despesas -------------------------------------------------- */}
          <Card>
            <h2 className="mb-4 text-sm font-semibold text-ink-700">Despesas</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-lg font-semibold text-danger sm:text-xl">{formatMoney(indicators?.despesas)}</p>
                <p className="text-xs text-ink-400">Total</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-ink-800 sm:text-xl">{expenseCount}</p>
                <p className="text-xs text-ink-400">Lançamentos</p>
              </div>
            </div>
          </Card>

          {/* Resultado --------------------------------------------------- */}
          <Card className="!bg-ink-800 !text-cream">
            <p className="text-xs text-cream/60">Resultado do período</p>
            <p className="mt-1 text-2xl font-semibold sm:text-3xl">{formatMoney(indicators?.resultado_caixa)}</p>
            <p className="mt-2 text-xs text-cream/50">
              {formatMoney(indicators?.recebido)} recebido − {formatMoney(indicators?.despesas)} em despesas
            </p>
          </Card>

          {/* Visão por serviço -------------------------------------------- */}
          {byService.length > 0 && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink-700">Por serviço</h2>
              <div className="space-y-2.5">
                {byService.map((s) => (
                  <div key={s.name} className="flex items-center justify-between text-sm">
                    <div>
                      <p className="font-medium text-ink-800">{s.name}</p>
                      <p className="text-xs text-ink-400">{s.count} atendimento{s.count !== 1 ? "s" : ""}</p>
                    </div>
                    <span className="font-semibold text-ink-800">{formatMoney(s.total)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Visão por profissional — só com 2+ ativas, sem virar ranking */}
          {professionals.length > 1 && byProfessional.length > 0 && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink-700">Por profissional</h2>
              <div className="space-y-2.5">
                {byProfessional.map((p) => (
                  <div key={p.name} className="flex items-center justify-between text-sm">
                    <div>
                      <p className="font-medium text-ink-800">{p.name}</p>
                      <p className="text-xs text-ink-400">{p.count} atendimento{p.count !== 1 ? "s" : ""}</p>
                    </div>
                    <span className="font-semibold text-ink-800">{formatMoney(p.total)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Pendências ------------------------------------------------ */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-700">Pagamentos pendentes</h2>
              <Link href="/financeiro/receitas?status=pendente" className="text-xs font-medium text-ink-500 hover:text-ink-800">
                Ver tudo
              </Link>
            </div>
            {pending.length === 0 ? (
              <p className="text-sm text-ink-300">Nenhuma pendência agora.</p>
            ) : (
              <div className="space-y-1">
                {pending.map((p) => (
                  <Link
                    key={p.id}
                    href={`/financeiro/receitas/${p.id}`}
                    className="flex items-center justify-between rounded-md py-1.5 hover:bg-ink-50"
                  >
                    <span className="text-sm font-medium text-ink-800">{p.clients?.name ?? p.description ?? "Recebimento"}</span>
                    <span className="text-sm font-semibold text-warning">
                      {formatMoney(Number(p.amount) - Number(p.paid_amount ?? 0))}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          {/* Atalhos ----------------------------------------------------- */}
          <div className="grid grid-cols-2 gap-3">
            <Link href="/financeiro/receitas">
              <Card interactive className="flex items-center gap-3">
                <Receipt className="size-5 shrink-0 text-ink-400" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink-800">Receitas</p>
                  <p className="text-xs text-ink-400">Ver todas</p>
                </div>
                <ArrowRight className="size-4 shrink-0 text-ink-300" />
              </Card>
            </Link>
            <Link href="/financeiro/despesas">
              <Card interactive className="flex items-center gap-3">
                <TrendingDown className="size-5 shrink-0 text-ink-400" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink-800">Despesas</p>
                  <p className="text-xs text-ink-400">Ver todas</p>
                </div>
                <ArrowRight className="size-4 shrink-0 text-ink-300" />
              </Card>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
