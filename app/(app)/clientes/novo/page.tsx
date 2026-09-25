import Link from "next/link";
import { ClienteForm } from "@/components/cliente-form";
import { ChevronLeft } from "lucide-react";

export default function NovaClientePage() {
  return (
    <div className="space-y-4 pb-4">
      <Link href="/clientes" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Clientes
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Nova cliente</h1>
      <ClienteForm />
    </div>
  );
}
