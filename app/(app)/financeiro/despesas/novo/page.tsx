import Link from "next/link";
import { DespesaForm } from "@/components/despesa-form";
import { ChevronLeft } from "lucide-react";

export default function NovaDespesaPage() {
  return (
    <div className="space-y-4 pb-4">
      <Link href="/financeiro/despesas" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Despesas
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Nova despesa</h1>
      <DespesaForm />
    </div>
  );
}
