import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Avatar } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/hive/format";
import {
  Phone,
  Instagram,
  Cake,
  Pencil,
  CalendarPlus,
  ChevronLeft,
  Scissors,
  XCircle,
  UserX,
} from "lucide-react";

type TimelineEntry = {
  key: string;
  date: string;
  kind: "agendamento" | "pagamento";
  title: string;
  subtitle: string;
  href?: string;
  status?: string;
  paymentTone?: "success" | "warning" | "neutral";
  paymentLabel?: string;
  amountLabel?: string;
};

function isBirthdaySoon(birthDate: string | null) {
  if (!birthDate) return false;
  const today = new Date();
  const bd = new Date(birthDate);
  const next = new Date(today.getFullYear(), bd.getMonth(), bd.getDate());
  if (next < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
    next.setFullYear(next.getFullYear() + 1);
  }
  const days = Math.round((next.getTime() - today.getTime()) / 86400000);
  return days >= 0 && days <= 14;
}

export default async function ClientePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  if (!client) notFound();

  const { data: appointments } = await supabase
    .from("appointments")
    .select("id, scheduled_start, status, price, professional_member_id, services(name)")
    .eq("client_id", id)
    .order("scheduled_start", { ascending: false });

  // RLS: quem não tem acesso ao financeiro recebe lista vazia aqui — a
  // timeline simplesmente não mostra pagamentos, sem erro (igual já era).
  const { data: payments } = await supabase
    .from("payments")
    .select("id, created_at, amount, paid_amount, status, method")
    .eq("client_id", id)
    .order("created_at", { ascending: false });

  // Nomes das profissionais pra aparecer no histórico — mesma função
  // security-definer já usada na Agenda (migration 0005), nada novo aqui.
  const { data: memberNames } = await supabase.rpc("get_company_member_names", {
    p_company_id: client.company_id,
  });
  const nameById = new Map<string, string>(
    ((memberNames as { member_id: string; full_name: string }[]) ?? []).map((n) => [n.member_id, n.full_name])
  );

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

  const timeline: TimelineEntry[] = [
    ...(appointments ?? []).map((a): TimelineEntry => {
      const svc = Array.isArray(a.services) ? a.services[0]?.name : (a.services as { name: string } | null)?.name;
      const prof = nameById.get(a.professional_member_id);
      return {
        key: `appt-${a.id}`,
        date: a.scheduled_start,
        kind: "agendamento",
        title: svc ?? "Atendimento",
        subtitle: [
          new Date(a.scheduled_start).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
          prof,
        ]
          .filter(Boolean)
          .join(" · "),
        status: a.status,
        amountLabel: formatMoney(a.price),
        href: `/agenda/${a.id}`,
      };
    }),
    ...(payments ?? []).map((p): TimelineEntry => ({
      key: `pay-${p.id}`,
      date: p.created_at,
      kind: "pagamento",
      title: `Pagamento · ${p.method}`,
      subtitle: new Date(p.created_at).toLocaleDateString("pt-BR"),
      paymentLabel: p.status === "pago" ? "Pago" : p.status === "parcial" ? "Parcial" : "Pendente",
      paymentTone: p.status === "pago" ? "success" : p.status === "parcial" ? "warning" : "neutral",
      amountLabel: formatMoney(p.amount),
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="space-y-5 pb-4">
      <Link href="/clientes" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Clientes
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={client.name} size="lg" />
          <div>
            <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">{client.name}</h1>
            <p className="text-sm text-ink-400">{client.phone ?? "Sem telefone"}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/clientes/${id}/editar`}>
            <Button variant="secondary" size="sm">
              <Pencil className="size-4" />
              Editar
            </Button>
          </Link>
          <Link href={`/agenda/novo?cliente=${id}`}>
            <Button size="sm">
              <CalendarPlus className="size-4" />
              Novo atendimento
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        {/* Coluna esquerda — contato, estatísticas, preferências */}
        <div className="space-y-5">
          <Card className="space-y-3">
            {client.phone && (
              <div className="flex items-center gap-2.5 text-sm">
                <Phone className="size-4 shrink-0 text-ink-300" />
                <span className="text-ink-700">{client.phone}</span>
              </div>
            )}
            {client.instagram && (
              <div className="flex items-center gap-2.5 text-sm">
                <Instagram className="size-4 shrink-0 text-ink-300" />
                <span className="text-ink-700">{client.instagram}</span>
              </div>
            )}
            {client.birth_date && (
              <div className="flex items-center gap-2.5 text-sm">
                <Cake className="size-4 shrink-0 text-ink-300" />
                <span className="text-ink-700">
                  {new Date(client.birth_date).toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })}
                </span>
                {isBirthdaySoon(client.birth_date) && (
                  <span className="rounded-full bg-gold-100 px-2 py-0.5 text-[11px] font-semibold text-gold-700">
                    em breve
                  </span>
                )}
              </div>
            )}
            {!client.phone && !client.instagram && !client.birth_date && (
              <p className="text-sm text-ink-300">Nenhum contato cadastrado.</p>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink-700">Estatísticas</h2>
            <div className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-400">Atendimentos</span>
                <span className="font-semibold text-ink-800">{concluded.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-400">Total gasto</span>
                <span className="font-semibold text-ink-800">{formatMoney(totalGasto)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-400">Última visita</span>
                <span className="font-semibold text-ink-800">
                  {client.last_visit_at ? new Date(client.last_visit_at).toLocaleDateString("pt-BR") : "—"}
                </span>
              </div>
              {topService && (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-ink-400">
                    <Scissors className="size-3.5" /> Mais realizado
                  </span>
                  <span className="truncate font-semibold text-ink-800">{topService}</span>
                </div>
              )}
              {cancelamentos > 0 && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-ink-400">
                    <XCircle className="size-3.5" /> Cancelamentos
                  </span>
                  <span className="font-semibold text-ink-800">{cancelamentos}</span>
                </div>
              )}
              {faltas > 0 && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-ink-400">
                    <UserX className="size-3.5" /> Faltas
                  </span>
                  <span className="font-semibold text-ink-800">{faltas}</span>
                </div>
              )}
            </div>
          </Card>

          {(client.preferences || client.notes) && (
            <Card className="space-y-3">
              {client.preferences && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Preferências</p>
                  <p className="text-sm text-ink-700">{client.preferences}</p>
                </div>
              )}
              {client.notes && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Observações</p>
                  <p className="text-sm text-ink-700">{client.notes}</p>
                </div>
              )}
            </Card>
          )}
        </div>

        {/* Coluna direita — histórico */}
        <div>
          <h2 className="mb-2 text-sm font-semibold text-ink-700">Histórico</h2>
          {timeline.length === 0 ? (
            <Card>
              <p className="text-sm text-ink-400">Nenhum histórico ainda.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {timeline.map((t) => {
                const content = (
                  <Card interactive={!!t.href} padding="sm" className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-800">{t.title}</p>
                      <p className="truncate text-xs text-ink-400">{t.subtitle}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      {t.amountLabel && <span className="text-sm font-semibold text-ink-700">{t.amountLabel}</span>}
                      {t.kind === "agendamento" && t.status && <StatusBadge status={t.status} />}
                      {t.kind === "pagamento" && t.paymentLabel && (
                        <Badge tone={t.paymentTone}>{t.paymentLabel}</Badge>
                      )}
                    </div>
                  </Card>
                );
                return t.href ? (
                  <Link key={t.key} href={t.href}>
                    {content}
                  </Link>
                ) : (
                  <div key={t.key}>{content}</div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
