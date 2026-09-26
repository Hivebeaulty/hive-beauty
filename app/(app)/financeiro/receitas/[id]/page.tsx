import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReceitaForm } from "@/components/receita-form";
import { ChevronLeft } from "lucide-react";

export default async function EditarReceitaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: payment } = await supabase.from("payments").select("*").eq("id", id).maybeSingle();

  if (!payment) notFound();

  return (
    <div className="space-y-4 pb-4">
      <Link href="/financeiro/receitas" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Receitas
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Editar recebimento</h1>
      {payment.appointment_id && (
        <p className="rounded-lg bg-gold-50 p-3 text-xs text-gold-700">
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
