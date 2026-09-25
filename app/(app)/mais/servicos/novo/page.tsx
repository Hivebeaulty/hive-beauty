import Link from "next/link";
import { ServicoForm } from "@/components/servico-form";
import { ChevronLeft } from "lucide-react";

export default function NovoServicoPage() {
  return (
    <div className="space-y-4 pb-4">
      <Link href="/mais/servicos" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Serviços
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Novo serviço</h1>
      <ServicoForm />
    </div>
  );
}
