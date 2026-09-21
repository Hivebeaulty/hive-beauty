import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";

export default async function ServicosPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);

  const { data: services } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price, active, service_categories(name)")
    .eq("company_id", membership!.companyId)
    .order("active", { ascending: false })
    .order("name");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">Serviços</h1>
        <Link
          href="/mais/servicos/novo"
          className="rounded-xl bg-plum-500 px-4 py-2 text-sm font-semibold text-white"
        >
          + Novo
        </Link>
      </div>

      {(!services || services.length === 0) && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="mb-4 text-charcoal-700">Ainda não existem serviços cadastrados.</p>
          <Link href="/mais/servicos/novo" className="font-semibold text-plum-500">
            Adicionar serviço
          </Link>
        </div>
      )}

      <div className="space-y-2">
        {services?.map((s) => {
          const category = Array.isArray(s.service_categories)
            ? s.service_categories[0]?.name
            : (s.service_categories as { name: string } | null)?.name;
          return (
            <Link
              key={s.id}
              href={`/mais/servicos/${s.id}`}
              className={`block rounded-2xl bg-white p-4 shadow-sm ${!s.active ? "opacity-50" : ""}`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-charcoal-900">{s.name}</p>
                  <p className="text-xs text-charcoal-500">
                    {category ? `${category} · ` : ""}
                    {s.duration_minutes} min
                  </p>
                </div>
                <p className="font-semibold text-plum-500">
                  R$ {Number(s.price).toFixed(2)}
                </p>
              </div>
              {!s.active && <p className="mt-1 text-xs text-charcoal-500">Inativo</p>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
