import Link from "next/link";
import { ReceitaForm } from "@/components/receita-form";
import { ChevronLeft } from "lucide-react";

export default function NovaReceitaPage() {
  return (
    <div className="space-y-4 pb-4">
      <Link href="/financeiro/receitas" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Receitas
      </Link>
      <h1 className="page-title">Novo recebimento</h1>
      <ReceitaForm />
    </div>
  );
}
