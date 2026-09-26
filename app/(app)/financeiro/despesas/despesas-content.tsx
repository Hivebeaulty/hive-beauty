"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getPeriodRange, PERIOD_LABEL, type Period } from "@/lib/hive/period";
import { expenseEffectiveDate, isWithinPeriod } from "@/lib/hive/finance";
import { formatMoney } from "@/lib/hive/format";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonListItem } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Plus, ChevronLeft, TrendingDown } from "lucide-react";

type ExpenseRow = {
  id: string;
  description: string;
  amount: number;
  paid_at: string | null;
  due_date: string | null;
  created_at: string;
  expense_categories: { name: string } | { name: string }[] | null;
};

const PERIOD_OPTIONS: Period[] = ["hoje", "semana", "mes", "mes_anterior"];

function categoryName(c: ExpenseRow["expense_categories"]) {
  return Array.isArray(c) ? c[0]?.name : c?.name;
}

export function DespesasContent() {
  const { companyId } = useCompany();
  const [period, setPeriod] = useState<Period>("mes");
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    // Traz tudo e filtra pela data efetiva em JS (paid_at > due_date >
    // created_at) — a versão anterior filtrava só por due_date e por isso
    // despesa sem vencimento definido nunca aparecia em nenhum período.
    const { data } = await supabase
      .from("expenses")
      .select("id, description, amount, paid_at, due_date, created_at, expense_categories(name)")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1000);
    setRows((data as unknown as ExpenseRow[]) ?? []);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const { start, end } = getPeriodRange(period);
  const filtered = useMemo(
    () => rows.filter((r) => isWithinPeriod(expenseEffectiveDate(r), start, end)),
    [rows, start, end]
  );
  const total = filtered.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="space-y-5 pb-4">
      <Link href="/financeiro" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Financeiro
      </Link>

      <PageHeader
        title="Despesas"
        actions={
          <Link href="/financeiro/despesas/novo">
            <Button size="sm">
              <Plus className="size-4" />
              Nova
            </Button>
          </Link>
        }
      />

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

      {!loading && filtered.length > 0 && (
        <Card padding="sm" className="flex items-center justify-between">
          <span className="text-sm text-ink-400">Total do período</span>
          <span className="text-lg font-semibold text-danger">{formatMoney(total)}</span>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={TrendingDown} title="Nenhuma despesa neste período" description="Ajuste o período ou cadastre uma nova despesa." />
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <Link key={r.id} href={`/financeiro/despesas/${r.id}`}>
              <Card interactive padding="sm" className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-800">{r.description}</p>
                  <p className="truncate text-xs text-ink-400">
                    {categoryName(r.expense_categories) ?? "Sem categoria"} · {new Date(expenseEffectiveDate(r)).toLocaleDateString("pt-BR")}
                  </p>
                </div>
                <span className="shrink-0 font-semibold text-ink-800">{formatMoney(r.amount)}</span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
