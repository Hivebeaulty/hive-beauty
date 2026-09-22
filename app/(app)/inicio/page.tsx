"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { subDays, format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getPeriodRange } from "@/lib/hive/period";
import { formatMoney, greetingForHour, firstName } from "@/lib/hive/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonListItem } from "@/components/ui/skeleton";
import { CalendarPlus, UserPlus, CalendarX, Sparkles, ArrowRight } from "lucide-react";

type PeriodIndicators = {
  atendimentos_realizados: number;
  faturado: number;
  recebido: number;
  despesas: number;
  resultado_caixa: number;
  pendente: number;
  clientes_novas: number;
  clientes_recorrentes: number;
};

type Appointment = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  price: number;
  clients: { name: string } | null;
  services: { name: string } | null;
};

type PendingPayment = {
  id: string;
  description: string | null;
  amount: number;
  paid_amount: number | null;
  clients: { name: string } | null;
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export default function InicioPage() {
  const { companyId, role } = useCompany();
  const canSeeFinance = role === "owner" || role === "admin";

  const [loading, setLoading] = useState(true);
  const [name, setName] = useState<string | null>(null);
  const [today, setToday] = useState<PeriodIndicators | null>(null);
  const [month, setMonth] = useState<PeriodIndicators | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [pending, setPending] = useState<PendingPayment[]>([]);
  const [activeClients, setActiveClients] = useState<number>(0);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const now = new Date();
    const todayStr = format(now, "yyyy-MM-dd");
    const dayStart = startOfDay(now);
    const dayEnd = addDays(dayStart, 1);
    const { start: monthStart, end: monthEnd } = getPeriodRange("mes");
    const activeSinceStr = format(subDays(now, 60), "yyyy-MM-dd");

    // Cada chamada roda com o privilégio de quem está logado — RLS já garante
    // que faturado/recebido/pendente venham zerados para quem não é
    // owner/admin (ver migration 0003), então não precisamos filtrar aqui.
    // Só decidimos o que RENDERIZAR com base no papel (canSeeFinance).
    const [
      { data: userData },
      { data: todayInd },
      { data: monthInd },
      { data: appts },
      { data: pend },
      { count: activeCount },
    ] = await Promise.all([
      supabase.auth.getUser(),
      supabase.rpc("get_period_indicators", { p_company_id: companyId, p_start: todayStr, p_end: todayStr }),
      supabase.rpc("get_period_indicators", { p_company_id: companyId, p_start: monthStart, p_end: monthEnd }),
      supabase
        .from("appointments")
        .select("id, scheduled_start, scheduled_end, status, price, clients(name), services(name)")
        .eq("company_id", companyId)
        .gte("scheduled_start", dayStart.toISOString())
        .lt("scheduled_start", dayEnd.toISOString())
        .order("scheduled_start"),
      supabase
        .from("payments")
        .select("id, description, amount, paid_amount, clients(name)")
        .eq("company_id", companyId)
        .in("status", ["pendente", "parcial"])
        .order("created_at", { ascending: false })
        .limit(3),
      supabase
        .from("clients")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .gte("last_visit_at", activeSinceStr),
    ]);

    setName(firstName(userData?.user?.user_metadata?.full_name as string | undefined));
    setToday((todayInd as unknown as PeriodIndicators[])?.[0] ?? null);
    setMonth((monthInd as unknown as PeriodIndicators[])?.[0] ?? null);
    setAppointments((appts as unknown as Appointment[]) ?? []);
    setPending((pend as unknown as PendingPayment[]) ?? []);
    setActiveClients(activeCount ?? 0);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const activeAppointments = appointments.filter((a) => a.status !== "cancelado");
  const greeting = greetingForHour(new Date().getHours());
  const dateLabel = new Date().toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });

  return (
    <div className="space-y-6 pb-4">
      {/* Saudação — o único lugar da interface, além do login, onde a
          serifada aparece. Momento de destaque pontual, não um padrão. */}
      <div>
        <h1 className="font-serif text-[26px] italic text-ink-800 sm:text-[30px]">
          {greeting}
          {name ? `, ${name}` : ""}.
        </h1>
        <p className="text-sm text-ink-400">Veja como está o seu negócio hoje.</p>
      </div>

      {/* Acesso rápido às ações mais frequentes (item 15 do briefing) */}
      <div className="flex flex-wrap gap-2">
        <Link href="/agenda/novo">
          <Button size="sm">
            <CalendarPlus className="size-4" />
            Novo atendimento
          </Button>
        </Link>
        <Link href="/clientes/novo">
          <Button variant="secondary" size="sm">
            <UserPlus className="size-4" />
            Nova cliente
          </Button>
        </Link>
      </div>

      {/* HOJE ------------------------------------------------------------ */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-700">Hoje</h2>
          <span className="text-xs capitalize text-ink-400">{dateLabel}</span>
        </div>

        {loading ? (
          <div className="mb-5 grid grid-cols-3 gap-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : (
          <div className={`mb-5 grid gap-4 ${canSeeFinance ? "grid-cols-3" : "grid-cols-2"}`}>
            {canSeeFinance && (
              <div>
                <p className="text-2xl font-semibold text-ink-800">{formatMoney(today?.recebido)}</p>
                <p className="text-xs text-ink-400">Faturamento</p>
              </div>
            )}
            <div>
              <p className="text-2xl font-semibold text-ink-800">{activeAppointments.length}</p>
              <p className="text-xs text-ink-400">Atendimentos</p>
            </div>
            {canSeeFinance && (
              <div>
                <p className={`text-2xl font-semibold ${pending.length > 0 ? "text-warning" : "text-ink-800"}`}>
                  {pending.length}
                </p>
                <p className="text-xs text-ink-400">Pendências</p>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2 border-t border-ink-100 pt-4">
          {loading ? (
            <>
              <SkeletonListItem />
              <SkeletonListItem />
            </>
          ) : activeAppointments.length === 0 ? (
            <EmptyState
              icon={CalendarX}
              title="Nenhum atendimento hoje"
              description="Aproveite para organizar a agenda dos próximos dias."
              action={
                <Link href="/agenda/novo">
                  <Button variant="secondary" size="sm">
                    Criar agendamento
                  </Button>
                </Link>
              }
            />
          ) : (
            activeAppointments.slice(0, 5).map((a) => (
              <Link
                key={a.id}
                href={`/agenda/${a.id}`}
                className="flex items-center gap-3 rounded-md py-2 transition-colors hover:bg-ink-50"
              >
                <div className="w-12 shrink-0 text-sm font-semibold text-ink-700">
                  {new Date(a.scheduled_start).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-800">{a.clients?.name}</p>
                  <p className="truncate text-xs text-ink-400">{a.services?.name}</p>
                </div>
                <StatusBadge status={a.status} />
              </Link>
            ))
          )}
        </div>

        {activeAppointments.length > 5 && (
          <Link
            href="/agenda"
            className="mt-3 flex items-center justify-center gap-1 border-t border-ink-100 pt-3 text-sm font-medium text-ink-600 hover:text-ink-800"
          >
            Ver agenda completa <ArrowRight className="size-3.5" />
          </Link>
        )}
      </Card>

      {/* NEGÓCIO (mês) ----------------------------------------------------- */}
      <Card>
        <h2 className="mb-4 text-sm font-semibold text-ink-700">Negócio no mês</h2>
        {loading ? (
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-y-5 sm:grid-cols-4">
            {canSeeFinance && (
              <div>
                <p className="text-lg font-semibold text-ink-800">{formatMoney(month?.faturado)}</p>
                <p className="text-xs text-ink-400">Faturamento</p>
              </div>
            )}
            <div>
              <p className="text-lg font-semibold text-ink-800">{month?.atendimentos_realizados ?? 0}</p>
              <p className="text-xs text-ink-400">Atendimentos</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-ink-800">{activeClients}</p>
              <p className="text-xs text-ink-400">Clientes ativas</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-ink-800">{month?.clientes_novas ?? 0}</p>
              <p className="text-xs text-ink-400">Clientes novas</p>
            </div>
          </div>
        )}
      </Card>

      {/* PENDÊNCIAS --------------------------------------------------------- */}
      {canSeeFinance && !loading && pending.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-700">Pendências</h2>
            <Link href="/financeiro" className="text-xs font-medium text-ink-500 hover:text-ink-800">
              Ver tudo
            </Link>
          </div>
          <div className="space-y-1">
            {pending.map((p) => (
              <Link
                key={p.id}
                href={`/financeiro/receitas/${p.id}`}
                className="flex items-center justify-between rounded-md py-2 transition-colors hover:bg-ink-50"
              >
                <p className="text-sm font-medium text-ink-800">{p.clients?.name ?? p.description ?? "Recebimento"}</p>
                <span className="text-sm font-semibold text-warning">
                  {formatMoney(Number(p.amount) - Number(p.paid_amount ?? 0))}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* Empresa nova / dia tranquilo — evita sensação de tela "vazia" */}
      {!loading && activeAppointments.length === 0 && (month?.atendimentos_realizados ?? 0) === 0 && (
        <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-ink-200 px-4 py-3 text-sm text-ink-500">
          <Sparkles className="size-4 shrink-0 text-gold-500" />
          Comece agendando o primeiro atendimento do mês.
        </div>
      )}
    </div>
  );
}
