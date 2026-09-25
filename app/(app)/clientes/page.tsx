"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonListItem } from "@/components/ui/skeleton";
import { Search, UserPlus, Users } from "lucide-react";

type ClientRow = {
  id: string;
  name: string;
  phone: string | null;
  last_visit_at: string | null;
  count: number;
};

export default function ClientesPage() {
  const { companyId } = useCompany();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from("clients").select("id, name, phone, last_visit_at").eq("company_id", companyId).order("name"),
      // Uma query agregada só (não N+1) — conta atendimentos concluídos por
      // cliente e agrupa no client. Tranquilo pro volume de uma agenda de salão.
      supabase
        .from("appointments")
        .select("client_id")
        .eq("company_id", companyId)
        .eq("status", "concluido"),
    ]).then(([{ data: clientRows }, { data: apptRows }]) => {
      const counts = new Map<string, number>();
      for (const a of apptRows ?? []) {
        counts.set(a.client_id, (counts.get(a.client_id) ?? 0) + 1);
      }
      setClients(
        (clientRows ?? []).map((c) => ({ ...c, count: counts.get(c.id) ?? 0 }))
      );
      setLoading(false);
    });
  }, [companyId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(q) || c.phone?.includes(q));
  }, [clients, query]);

  return (
    <div className="space-y-5 pb-4">
      <PageHeader
        title="Clientes"
        actions={
          <Link href="/clientes/novo">
            <Button size="sm">
              <UserPlus className="size-4" />
              Nova
            </Button>
          </Link>
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

      {loading ? (
        <div className="space-y-2">
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={query ? Search : Users}
          title={query ? "Nenhuma cliente encontrada" : "Ainda não há clientes cadastradas"}
          description={query ? "Tente buscar por outro nome ou telefone." : "Cadastre a primeira cliente para começar a preencher a agenda."}
          action={
            !query ? (
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
                    {c.last_visit_at &&
                      ` · última visita em ${new Date(c.last_visit_at).toLocaleDateString("pt-BR")}`}
                  </p>
                </div>
                {c.count > 0 && (
                  <span className="shrink-0 text-xs font-medium text-ink-400">
                    {c.count} atend.
                  </span>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
