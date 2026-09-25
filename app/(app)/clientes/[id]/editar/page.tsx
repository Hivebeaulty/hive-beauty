import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClienteForm } from "@/components/cliente-form";
import { ChevronLeft } from "lucide-react";

export default async function EditarClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();

  if (!client) notFound();

  return (
    <div className="space-y-4 pb-4">
      <Link href={`/clientes/${id}`} className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        {client.name}
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Editar cliente</h1>
      <ClienteForm
        initial={{
          id: client.id,
          name: client.name,
          phone: client.phone ?? "",
          instagram: client.instagram ?? "",
          birth_date: client.birth_date ?? "",
          preferences: client.preferences ?? "",
          notes: client.notes ?? "",
        }}
      />
    </div>
  );
}
