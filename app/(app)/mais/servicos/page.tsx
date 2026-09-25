"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonListItem } from "@/components/ui/skeleton";
import { formatMoney, formatDuration } from "@/lib/hive/format";
import { Search, Plus, Scissors } from "lucide-react";

type Service = {
  id: string;
  name: string;
  duration_minutes: number;
  price: number;
  active: boolean;
  category_id: string | null;
};
type Category = { id: string; name: string; sort_order: number };

const SEM_CATEGORIA = "__none__";

export default function ServicosPage() {
  const { companyId } = useCompany();
  const [services, setServices] = useState<Service[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase
        .from("services")
        .select("id, name, duration_minutes, price, active, category_id")
        .eq("company_id", companyId)
        .order("name"),
      supabase.from("service_categories").select("id, name, sort_order").eq("company_id", companyId).order("sort_order"),
    ]).then(([{ data: s }, { data: c }]) => {
      setServices((s as Service[]) ?? []);
      setCategories((c as Category[]) ?? []);
      setLoading(false);
    });
  }, [companyId]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? services.filter((s) => s.name.toLowerCase().includes(q)) : services;

    const byCategory = new Map<string, Service[]>();
    for (const s of filtered) {
      const key = s.category_id ?? SEM_CATEGORIA;
      byCategory.set(key, [...(byCategory.get(key) ?? []), s]);
    }

    const groups = categories
      .filter((c) => byCategory.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, services: byCategory.get(c.id)! }));
    if (byCategory.has(SEM_CATEGORIA)) {
      groups.push({ id: SEM_CATEGORIA, name: "Sem categoria", services: byCategory.get(SEM_CATEGORIA)! });
    }
    // Inativos por último dentro de cada grupo, sem sumir da lista.
    for (const g of groups) g.services.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "pt-BR"));
    return groups;
  }, [services, categories, query]);

  const hasAny = services.length > 0;
  const hasResults = grouped.some((g) => g.services.length > 0);

  return (
    <div className="space-y-5 pb-4">
      <PageHeader
        title="Serviços"
        actions={
          <Link href="/mais/servicos/novo">
            <Button size="sm">
              <Plus className="size-4" />
              Novo
            </Button>
          </Link>
        }
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-300" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar serviço..."
          className="pl-10"
        />
      </div>

      {loading ? (
        <div className="space-y-2">
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      ) : !hasAny ? (
        <EmptyState
          icon={Scissors}
          title="Ainda não há serviços cadastrados"
          description="Cadastre o que você oferece para começar a agendar atendimentos."
          action={
            <Link href="/mais/servicos/novo">
              <Button variant="secondary" size="sm">
                Adicionar serviço
              </Button>
            </Link>
          }
        />
      ) : !hasResults ? (
        <EmptyState icon={Search} title="Nenhum serviço encontrado" description="Tente buscar por outro nome." />
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => (
            <div key={g.id}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{g.name}</h2>
              <div className="space-y-2">
                {g.services.map((s) => (
                  <Link key={s.id} href={`/mais/servicos/${s.id}`}>
                    <Card interactive padding="sm" className={`flex items-center justify-between gap-3 ${!s.active ? "opacity-60" : ""}`}>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink-800">{s.name}</p>
                        <p className="text-xs text-ink-400">{formatDuration(s.duration_minutes)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {!s.active && <Badge tone="neutral">Inativo</Badge>}
                        <span className="font-semibold text-ink-800">{formatMoney(s.price)}</span>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
