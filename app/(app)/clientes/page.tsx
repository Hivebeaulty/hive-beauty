import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);

  let query = supabase
    .from("clients")
    .select("id, name, phone, last_visit_at")
    .eq("company_id", membership!.companyId)
    .order("name");

  if (q) query = query.ilike("name", `%${q}%`);

  const { data: clients } = await query;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">Clientes</h1>
        <Link
          href="/clientes/novo"
          className="rounded-xl bg-plum-500 px-4 py-2 text-sm font-semibold text-white"
        >
          + Nova
        </Link>
      </div>

      <form method="GET" className="flex">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Buscar por nome..."
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </form>

      {(!clients || clients.length === 0) && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="mb-4 text-charcoal-700">
            {q ? "Nenhuma cliente encontrada." : "Ainda não existem clientes cadastradas."}
          </p>
          {!q && (
            <Link href="/clientes/novo" className="font-semibold text-plum-500">
              Adicionar cliente
            </Link>
          )}
        </div>
      )}

      <div className="space-y-2">
        {clients?.map((c) => (
          <Link
            key={c.id}
            href={`/clientes/${c.id}`}
            className="block rounded-2xl bg-white p-4 shadow-sm"
          >
            <p className="font-semibold text-charcoal-900">{c.name}</p>
            <p className="text-xs text-charcoal-500">
              {c.phone ?? "Sem telefone"}
              {c.last_visit_at ? ` · última visita em ${new Date(c.last_visit_at).toLocaleDateString("pt-BR")}` : ""}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
