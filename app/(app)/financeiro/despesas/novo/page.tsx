import { DespesaForm } from "@/components/despesa-form";

export default function NovaDespesaPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-charcoal-900">Nova despesa</h1>
      <DespesaForm />
    </div>
  );
}
