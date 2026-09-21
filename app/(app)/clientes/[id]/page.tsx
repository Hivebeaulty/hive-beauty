import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { STATUS_LABEL, STATUS_COLOR } from "@/lib/hive/status";

type TimelineEntry = {
  key: string;
  date: string;
  kind: "agendamento" | "pagamento";
  title: string;
  subtitle: string;
  badge: { label: string; className: string };
  href?: string;
};

export default async function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  if (!client) notFound();

  const { data: appointments } = await supabase
    .from("appointments")
    .select("id, scheduled_start, status, price, services(name)")
    .eq("client_id", id)
    .order("scheduled_start", { ascending: false });

  // Se o papel do usuário não tiver acesso ao financeiro, o RLS retorna uma
  // lista vazia aqui — a timeline simplesmente não mostra pagamentos, sem erro.
  const { data: payments } = await supabase
    .from("payments")
    .select("id, created_at, amount, paid_amount, status, method, description")
    .eq("client_id", id)
    .order("created_at", { ascending: false });

  const concluded = appointments?.filter((a) => a.status === "concluido") ?? [];
  const totalGasto = concluded.reduce((sum, a) => sum + Number(a.price), 0);
  const cancelamentos = appointments?.filter((a) => a.status === "cancelado").length ?? 0;
  const faltas = appointments?.filter((a) => a.status === "nao_compareceu").length ?? 0;

  const serviceCounts = new Map<string, number>();
  for (const a of concluded) {
    const svc = Array.isArray(a.services) ? a.services[0]?.name : (a.services as { name: string } | null)?.name;
    if (svc) serviceCounts.set(svc, (serviceCounts.get(svc) ?? 0) + 1);
  }
  const topService = [...serviceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Timeline consolidada: agendamentos + pagamentos, ordenados por data.
  const timeline: TimelineEntry[] = [
    ...(appointments ?? []).map((a): TimelineEntry => {
      const svc = Array.isArray(a.services) ? a.services[0]?.name : (a.services as { name: string } | null)?.name;
      return {
        key: `appt-${a.id}`,
        date: a.scheduled_start,
        kind: "agendamento",
        title: svc ?? "Agendamento",
        subtitle: new Date(a.scheduled_start).toLocaleString("pt-BR", {
          day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        }),
        badge: { label: STATUS_LABEL[a.status] ?? a.status, className: STATUS_COLOR[a.status] ?? "" },
        href: `/agenda/${a.id}`,
      };
    }),
    ...(payments ?? []).map((p): TimelineEntry => ({
      key: `pay-${p.id}`,
      date: p.created_at,
      kind: "pagamento",
      title: `Pagamento · R$ ${Number(p.amount).toFixed(2)}`,
      subtitle: `${p.method} · ${new Date(p.created_at).toLocaleDateString("pt-BR")}`,
      badge: {
        label: p.status === "pago" ? "Pago" : p.status === "parcial" ? "Parcial" : "Pendente",
        className: p.status === "pago" ? "bg-success text-white" : "bg-warning text-white",
      },
      href: `/financeiro/receitas/${p.id}`,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-charcoal-900">{client.name}</h1>
          <p className="text-sm text-charcoal-700">{client.phone ?? "Sem telefone"}</p>
        </div>
        <Link href={`/clientes/${id}/editar`} className="text-sm font-semibold text-plum-500">
          Editar
        </Link>
      </div>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-lg font-bold text-charcoal-900">{concluded.length}</p>
            <p className="text-xs text-charcoal-500">Atendimentos</p>
          </div>
          <div>
            <p className="text-lg font-bold text-charcoal-900">R$ {totalGasto.toFixed(2)}</p>
            <p className="text-xs text-charcoal-500">Total gasto</p>
          </div>
          <div>
            <p className="truncate text-lg font-bold text-charcoal-900">{topService ?? "—"}</p>
            <p className="text-xs text-charcoal-500">Mais realizado</p>
          </div>
        </div>
        <div className="mt-3 flex justify-center gap-4 text-xs text-charcoal-500">
          <span>Última visita: {client.last_visit_at ? new Date(client.last_visit_at).toLocaleDateString("pt-BR") : "—"}</span>
          {cancelamentos > 0 && <span>· {cancelamentos} cancelamento(s)</span>}
          {faltas > 0 && <span>· {faltas} falta(s)</span>}
        </div>
      </section>

      {(client.preferences || client.notes) && (
        <section className="space-y-2 rounded-2xl bg-white p-5 shadow-sm">
          {client.preferences && (
            <p className="text-sm text-charcoal-700">
              <span className="font-semibold text-charcoal-900">Preferências: </span>
              {client.preferences}
            </p>
          )}
          {client.notes && (
            <p className="text-sm text-charcoal-700">
              <span className="font-semibold text-charcoal-900">Observações: </span>
              {client.notes}
            </p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-plum-500">
          Linha do tempo
        </h2>
        {timeline.length === 0 && <p className="text-sm text-charcoal-500">Nenhum histórico ainda.</p>}
        <div className="space-y-2">
          {timeline.map((t) => (
            <Link
              key={t.key}
              href={t.href ?? "#"}
              className="flex items-center justify-between rounded-xl bg-white p-3 shadow-sm"
            >
              <div>
                <p className="text-sm font-medium text-charcoal-900">{t.title}</p>
                <p className="text-xs text-charcoal-500">{t.subtitle}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${t.badge.className}`}>
                {t.badge.label}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
