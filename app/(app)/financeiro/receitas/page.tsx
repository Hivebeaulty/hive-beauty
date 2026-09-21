import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";

const STATUS_LABEL: Record<string, string> = { pago: "Pago", pendente: "Pendente", parcial: "Parcial" };
const STATUS_COLOR: Record<string, string> = {
  pago: "text-success",
  pendente: "text-warning",
  parcial: "text-warning",
};

export default async function ReceitasPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);

  let query = supabase
    .from("payments")
    .select("id, description, amount, paid_amount, status, created_at, clients(name), appointments(services(name))")
    .eq("company_id", membership!.companyId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (status) query = query.eq("status", status);

  const { data: payments } = await query;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">Receitas</h1>
        <Link
          href="/financeiro/receitas/novo"
          className="rounded-xl bg-plum-500 px-4 py-2 text-sm font-semibold text-white"
        >
          + Nova
        </Link>
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {[
          { key: undefined, label: "Todas" },
          { key: "pago", label: "Pagas" },
          { key: "pendente", label: "Pendentes" },
          { key: "parcial", label: "Parciais" },
        ].map((opt) => (
          <Link
            key={opt.label}
            href={opt.key ? `/financeiro/receitas?status=${opt.key}` : "/financeiro/receitas"}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${
              status === opt.key ? "bg-plum-500 text-white" : "bg-white text-charcoal-700"
            }`}
          >
            {opt.label}
          </Link>
        ))}
      </div>

      {(!payments || payments.length === 0) && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="text-charcoal-700">Nenhum recebimento encontrado.</p>
        </div>
      )}

      <div className="space-y-2">
        {payments?.map((p) => {
          const clientName = Array.isArray(p.clients) ? p.clients[0]?.name : (p.clients as { name: string } | null)?.name;
          const apptServices = p.appointments as unknown as { services: { name: string } | { name: string }[] | null } | null;
          const svcName = apptServices
            ? Array.isArray(apptServices.services) ? apptServices.services[0]?.name : (apptServices.services as { name: string } | null)?.name
            : null;
          return (
            <Link
              key={p.id}
              href={`/financeiro/receitas/${p.id}`}
              className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm"
            >
              <div>
                <p className="font-semibold text-charcoal-900">{clientName ?? p.description ?? "Recebimento"}</p>
                <p className="text-xs text-charcoal-500">
                  {svcName ?? "Recebimento avulso"} ·{" "}
                  {new Date(p.created_at).toLocaleDateString("pt-BR")}
                </p>
              </div>
              <div className="text-right">
                <p className="font-semibold text-success">R$ {Number(p.amount).toFixed(2)}</p>
                <p className={`text-xs font-medium ${STATUS_COLOR[p.status]}`}>{STATUS_LABEL[p.status]}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
