import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { getPeriodRange, PERIOD_LABEL, type Period } from "@/lib/hive/period";

export default async function DespesasPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: Period }>;
}) {
  const { period = "mes" } = await searchParams;
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  const { start, end } = getPeriodRange(period);

  const { data: expenses } = await supabase
    .from("expenses")
    .select("id, description, amount, status, due_date, expense_categories(name)")
    .eq("company_id", membership!.companyId)
    .gte("due_date", start)
    .lte("due_date", end)
    .order("due_date", { ascending: false });

  const total = expenses?.reduce((sum, e) => sum + Number(e.amount), 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">Despesas</h1>
        <Link
          href="/financeiro/despesas/novo"
          className="rounded-xl bg-plum-500 px-4 py-2 text-sm font-semibold text-white"
        >
          + Nova
        </Link>
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {(["hoje", "semana", "mes"] as Period[]).map((p) => (
          <Link
            key={p}
            href={`/financeiro/despesas?period=${p}`}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${
              period === p ? "bg-plum-500 text-white" : "bg-white text-charcoal-700"
            }`}
          >
            {PERIOD_LABEL[p]}
          </Link>
        ))}
      </div>

      <p className="text-sm text-charcoal-700">
        Total no período: <span className="font-bold text-danger">R$ {total.toFixed(2)}</span>
      </p>

      {(!expenses || expenses.length === 0) && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="mb-4 text-charcoal-700">Nenhuma despesa neste período.</p>
          <Link href="/financeiro/despesas/novo" className="font-semibold text-plum-500">
            Adicionar despesa
          </Link>
        </div>
      )}

      <div className="space-y-2">
        {expenses?.map((e) => {
          const category = Array.isArray(e.expense_categories)
            ? e.expense_categories[0]?.name
            : (e.expense_categories as { name: string } | null)?.name;
          return (
            <Link
              key={e.id}
              href={`/financeiro/despesas/${e.id}`}
              className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm"
            >
              <div>
                <p className="font-semibold text-charcoal-900">{e.description}</p>
                <p className="text-xs text-charcoal-500">
                  {category ?? "Sem categoria"}
                  {e.due_date ? ` · ${new Date(e.due_date).toLocaleDateString("pt-BR")}` : ""}
                </p>
              </div>
              <p className="font-semibold text-danger">R$ {Number(e.amount).toFixed(2)}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
