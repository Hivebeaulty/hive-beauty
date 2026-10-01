"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonListItem } from "@/components/ui/skeleton";
import {
  computeClientRelationship,
  classifySegments,
  daysUntilNextBirthday,
  birthdayLabel,
  type ClientSegment,
} from "@/lib/hive/relationship";
import { cn } from "@/lib/utils";
import { Search, UserPlus, Upload, Users, Cake, AlertCircle } from "lucide-react";

type ClientRow = {
  id: string;
  name: string;
  phone: string | null;
  last_visit_at: string | null;
  birth_date: string | null;
  count: number;
  isOverdue: boolean;
  daysToBirthday: number | null;
  segments: ClientSegment[];
};

const SEGMENT_OPTIONS: { value: ClientSegment; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "novas", label: "Novas" },
  { value: "recorrentes", label: "Recorrentes" },
  { value: "inativas", label: "Inativas" },
  { value: "aniversariantes", label: "Aniversariantes" },
];

export default function ClientesPage() {
  const { companyId } = useCompany();
  const searchParams = useSearchParams();
  const initialSegment = (searchParams.get("segmento") as ClientSegment) || "todas";
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<ClientSegment>(initialSegment);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from("clients").select("id, name, phone, last_visit_at, birth_date").eq("company_id", companyId).order("name"),
      // Só client_id + data — o suficiente pra calcular frequência de cada
      // cliente sem trazer o histórico inteiro (serviço, preço etc. já
      // existem no perfil individual, não precisam vir aqui).
      supabase.from("appointments").select("client_id, scheduled_start").eq("company_id", companyId).eq("status", "concluido"),
    ]).then(([{ data: clientRows }, { data: apptRows }]) => {
      const visitsByClient = new Map<string, string[]>();
      for (const a of apptRows ?? []) {
        visitsByClient.set(a.client_id, [...(visitsByClient.get(a.client_id) ?? []), a.scheduled_start]);
      }

      setClients(
        (clientRows ?? []).map((c) => {
          const rel = computeClientRelationship(visitsByClient.get(c.id) ?? []);
          const daysToBirthday = daysUntilNextBirthday(c.birth_date);
          return {
            ...c,
            count: rel.visitCount,
            isOverdue: rel.isOverdue,
            daysToBirthday,
            segments: classifySegments(rel, daysToBirthday),
          };
        })
      );
      setLoading(false);
    });
  }, [companyId]);

  const birthdaysSoon = useMemo(
    () =>
      clients
        .filter((c) => c.daysToBirthday !== null && c.daysToBirthday <= 30)
        .sort((a, b) => (a.daysToBirthday ?? 0) - (b.daysToBirthday ?? 0))
        .slice(0, 5),
    [clients]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients.filter((c) => {
      const matchesQuery = !q || c.name.toLowerCase().includes(q) || c.phone?.includes(q);
      const matchesSegment = segment === "todas" || c.segments.includes(segment);
      return matchesQuery && matchesSegment;
    });
  }, [clients, query, segment]);

  return (
    <div className="space-y-5 pb-4">
      <PageHeader
        title="Clientes"
        actions={
          <div className="flex gap-2">
            <Link href="/clientes/importar">
              <Button variant="secondary" size="sm">
                <Upload className="size-4" />
                <span className="hidden sm:inline">Importar</span>
              </Button>
            </Link>
            <Link href="/clientes/novo">
              <Button size="sm">
                <UserPlus className="size-4" />
                Nova
              </Button>
            </Link>
          </div>
        }
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-300" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nome ou telefone..."
          className="pl-10"
        />
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {SEGMENT_OPTIONS.map((s) => (
          <button
            key={s.value}
            onClick={() => setSegment(s.value)}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              segment === s.value ? "bg-ink-800 text-cream" : "bg-ink-50 text-ink-600 hover:bg-ink-100"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Aniversários — discreto, só aparece quando há alguém nos próximos 30 dias */}
      {!loading && birthdaysSoon.length > 0 && segment === "todas" && !query && (
        <Card padding="sm">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
            <Cake className="size-3.5" />
            Aniversários próximos
          </div>
          <div className="space-y-1.5">
            {birthdaysSoon.map((c) => (
              <Link key={c.id} href={`/clientes/${c.id}`} className="flex items-center justify-between rounded-md py-1 hover:bg-ink-50">
                <span className="text-sm font-medium text-ink-800">{c.name}</span>
                <span
                  className={cn(
                    "text-xs font-medium",
                    c.daysToBirthday === 0 ? "text-gold-700" : "text-ink-400"
                  )}
                >
                  {birthdayLabel(c.daysToBirthday!)}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={query || segment !== "todas" ? Search : Users}
          title={clients.length === 0 ? "Ainda não há clientes cadastradas" : "Nenhuma cliente encontrada"}
          description={
            clients.length === 0
              ? "Cadastre a primeira cliente para começar a preencher a agenda."
              : "Tente ajustar a busca ou o filtro."
          }
          action={
            clients.length === 0 ? (
              <Link href="/clientes/novo">
                <Button variant="secondary" size="sm">
                  Adicionar cliente
                </Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <Link key={c.id} href={`/clientes/${c.id}`}>
              <Card interactive className="flex items-center gap-3" padding="sm">
                <Avatar name={c.name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink-800">{c.name}</p>
                  <p className="truncate text-xs text-ink-400">
                    {c.phone ?? "Sem telefone"}
                    {c.last_visit_at && ` · última visita em ${new Date(c.last_visit_at).toLocaleDateString("pt-BR")}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.isOverdue && (
                    <span title="Sem retorno dentro do padrão dela">
                      <AlertCircle className="size-4 text-warning" />
                    </span>
                  )}
                  {c.daysToBirthday !== null && c.daysToBirthday <= 7 && (
                    <span title={birthdayLabel(c.daysToBirthday)}>
                      <Cake className="size-4 text-gold-500" />
                    </span>
                  )}
                  {c.count > 0 && <span className="text-xs font-medium text-ink-400">{c.count} atend.</span>}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
