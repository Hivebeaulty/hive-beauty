"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getPeriodRange, periodBoundsISO, PERIOD_LABEL, type Period } from "@/lib/hive/period";
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from "@/lib/hive/finance";
import { formatMoney } from "@/lib/hive/format";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonListItem } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Plus, ChevronLeft, Receipt } from "lucide-react";

type PaymentRow = {
  id: string;
  amount: number;
  paid_amount: number | null;
  method: string;
  status: string;
  created_at: string;
  clients: { name: string } | null;
  appointments: { services: { name: string } | { name: string }[] | null } | null;
};

const PERIOD_OPTIONS: Period[] = ["hoje", "semana", "mes", "mes_anterior"];
const STATUS_TONE: Record<string, "success" | "warning" | "neutral"> = {
  pago: "success",
  parcial: "warning",
  pendente: "neutral",
};

function serviceName(a: PaymentRow["appointments"]) {
  const s = a?.services;
  return Array.isArray(s) ? s[0]?.name : s?.name;
}

export function ReceitasContent() {
  const { companyId } = useCompany();
  const searchParams = useSearchParams();
  const [period, setPeriod] = useState<Period>("mes");
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "todos");
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { start, end } = getPeriodRange(period);
    const bounds = periodBoundsISO(start, end);
    const supabase = createClient();
    let query = supabase
      .from("payments")
      .select("id, amount, paid_amount, method, status, created_at, clients(name), appointments(services(name))")
      .eq("company_id", companyId)
      .gte("created_at", bounds.from)
      .lte("created_at", bounds.to)
      .order("created_at", { ascending: false });
    if (statusFilter !== "todos") query = query.eq("status", statusFilter);

    const { data } = await query;
    setRows((data as unknown as PaymentRow[]) ?? []);
    setLoading(false);
  }, [companyId, period, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5 pb-4">
      <Link href="/financeiro" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Financeiro
      </Link>

      <PageHeader
        title="Receitas"
        actions={
          <Link href="/financeiro/receitas/novo">
            <Button size="sm">
              <Plus className="size-4" />
              Novo
            </Button>
          </Link>
        }
      />

      <div className="space-y-2">
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
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {["todos", "pago", "parcial", "pendente"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                statusFilter === s
                  ? "border-ink-800 bg-ink-800 text-cream"
                  : "border-ink-200 bg-surface text-ink-600 hover:bg-ink-50"
              )}
            >
              {s === "todos" ? "Todos" : PAYMENT_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Receipt} title="Nenhum recebimento neste período" description="Ajuste o período ou o filtro de status." />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Link key={r.id} href={`/financeiro/receitas/${r.id}`}>
              <Card interactive padding="sm" className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-800">{r.clients?.name ?? "Recebimento avulso"}</p>
                  <p className="truncate text-xs text-ink-400">
                    {serviceName(r.appointments) ?? "Sem atendimento vinculado"} · {new Date(r.created_at).toLocaleDateString("pt-BR")} · {PAYMENT_METHOD_LABEL[r.method] ?? r.method}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="text-sm font-semibold text-ink-800">{formatMoney(r.amount)}</span>
                  <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{PAYMENT_STATUS_LABEL[r.status] ?? r.status}</Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
