import { ServicoForm } from "@/components/servico-form";

export default function NovoServicoPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-charcoal-900">Novo serviço</h1>
      <ServicoForm />
    </div>
  );
}
