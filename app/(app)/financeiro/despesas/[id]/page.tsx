import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DespesaForm } from "@/components/despesa-form";
import { ChevronLeft } from "lucide-react";

export default async function EditarDespesaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: expense } = await supabase
    .from("expenses")
    .select("*, expense_categories(name)")
    .eq("id", id)
    .maybeSingle();

  if (!expense) notFound();

  const categoryName = Array.isArray(expense.expense_categories)
    ? expense.expense_categories[0]?.name
    : (expense.expense_categories as { name: string } | null)?.name;

  return (
    <div className="space-y-4 pb-4">
      <Link href="/financeiro/despesas" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Despesas
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Editar despesa</h1>
      <DespesaForm
        initial={{
          id: expense.id,
          description: expense.description,
          categoryName: categoryName ?? "",
          amount: Number(expense.amount),
          payment_method: expense.payment_method ?? "pix",
          status: expense.status,
          due_date: expense.due_date ?? "",
          notes: "",
          paid_at: expense.paid_at,
        }}
      />
    </div>
  );
}
