import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClienteForm } from "@/components/cliente-form";

export default async function EditarClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();

  if (!client) notFound();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-charcoal-900">Editar cliente</h1>
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
