import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ServicoForm } from "@/components/servico-form";
import { ChevronLeft } from "lucide-react";

export default async function EditarServicoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: service } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price, active, service_categories(name)")
    .eq("id", id)
    .maybeSingle();

  if (!service) notFound();

  const categoryName = Array.isArray(service.service_categories)
    ? service.service_categories[0]?.name
    : (service.service_categories as { name: string } | null)?.name;

  return (
    <div className="space-y-4 pb-4">
      <Link href="/mais/servicos" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Serviços
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Editar serviço</h1>
      <ServicoForm
        initial={{
          id: service.id,
          name: service.name,
          categoryName: categoryName ?? "",
          duration_minutes: service.duration_minutes,
          price: Number(service.price),
          active: service.active,
        }}
      />
    </div>
  );
}
