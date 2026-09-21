import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DespesaForm } from "@/components/despesa-form";

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
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-charcoal-900">Editar despesa</h1>
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
        }}
      />
    </div>
  );
}
