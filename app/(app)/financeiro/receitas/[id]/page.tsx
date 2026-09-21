import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReceitaForm } from "@/components/receita-form";

export default async function EditarReceitaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: payment } = await supabase.from("payments").select("*").eq("id", id).maybeSingle();

  if (!payment) notFound();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-charcoal-900">Editar recebimento</h1>
      {payment.appointment_id && (
        <p className="rounded-xl bg-blush-200 p-3 text-xs text-charcoal-700">
          Este recebimento está vinculado a um atendimento na Agenda. Editar aqui não altera o
          agendamento original.
        </p>
      )}
      <ReceitaForm
        initial={{
          id: payment.id,
          description: payment.description ?? "",
          client_id: payment.client_id ?? "",
          amount: Number(payment.amount),
          paid_amount: payment.paid_amount ? Number(payment.paid_amount) : null,
          method: payment.method,
          status: payment.status,
        }}
      />
    </div>
  );
}
