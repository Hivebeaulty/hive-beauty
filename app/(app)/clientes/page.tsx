"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonListItem } from "@/components/ui/skeleton";
import { birthdayLabel, normalizeSegmentParam, type ClientSegment } from "@/lib/hive/relationship";
import { keepVisibleSelection } from "@/lib/hive/bulk-clients";
import { ClientesBulkActions } from "@/components/clientes-bulk-actions";
import { loadClientRows, type ClientRow } from "@/lib/hive/clients-data";
import { phoneDisplay } from "@/lib/hive/phone";
import { formatDateOnly } from "@/lib/hive/format";
import { cn } from "@/lib/utils";
import { Search, UserPlus, Upload, Users, Cake, AlertCircle, Archive, MessageSquareText, ListChecks } from "lucide-react";

type View = ClientSegment | "arquivadas";

const SEGMENT_OPTIONS: { value: ClientSegment; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "novas", label: "Novas" },
  { value: "recorrentes", label: "Recorrentes" },
  { value: "sumidas", label: "Sumidas" },
  { value: "fora_do_padrao", label: "Fora do padrão" },
  { value: "aniversariantes", label: "Aniversariantes" },
];

// Uma linha explicando o filtro escolhido — a profissional não precisa
// adivinhar a regra por trás de cada etiqueta.
const SEGMENT_HELP: Partial<Record<View, string>> = {
  novas: "Clientes com até 1 atendimento concluído.",
  recorrentes: "Clientes que voltam: 2 ou mais atendimentos, dentro do ritmo delas.",
  sumidas: "Clientes ativas que passaram do tempo esperado sem voltar (60 dias quando ainda há pouco histórico). Quem você inativou fica na aba Inativas.",
  fora_do_padrao: "Já passaram de 1,5 vez o intervalo médio entre as visitas delas.",
  aniversariantes: "Aniversário nos próximos 30 dias.",
  arquivadas: "Clientes que você inativou: não aparecem para agendamentos e não recebem mensagens automáticas. O histórico continua guardado; abra uma para reativar.",
};

const VALID_VIEWS = new Set<string>([...SEGMENT_OPTIONS.map((s) => s.value), "arquivadas"]);

export default function ClientesPage() {
  const { companyId } = useCompany();
  const searchParams = useSearchParams();
  const param = normalizeSegmentParam(searchParams.get("segmento") ?? "");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>(VALID_VIEWS.has(param) ? (param as View) : "todas");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Seleção múltipla (exclusão / inativação em massa)
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    const { rows, failed } = await loadClientRows(createClient(), companyId);
    setClients(rows);
    setFailed(failed);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    loadClientRows(createClient(), companyId).then(({ rows, failed }) => {
      if (cancelled) return;
      setClients(rows);
      setFailed(failed);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const active = useMemo(() => clients.filter((c) => !c.archived_at), [clients]);
  const archivedCount = clients.length - active.length;

  const birthdaysSoon = useMemo(
    () =>
      active
        .filter((c) => c.daysToBirthday !== null && c.daysToBirthday <= 30)
        .sort((a, b) => (a.daysToBirthday ?? 0) - (b.daysToBirthday ?? 0))
        .slice(0, 5),
    [active]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    const pool = view === "arquivadas" ? clients.filter((c) => c.archived_at) : active;
    return pool.filter((c) => {
      const matchesQuery =
        !q ||
        c.name.toLowerCase().includes(q) ||
        (qDigits.length > 0 &&
          ((c.phone ?? "").replace(/\D/g, "").includes(qDigits) || (c.phone_normalized ?? "").includes(qDigits)));
      const matchesView = view === "arquivadas" || view === "todas" || c.segments.includes(view);
      return matchesQuery && matchesView;
    });
  }, [clients, active, query, view]);

  const emptyBase = view === "arquivadas" ? archivedCount === 0 : active.length === 0;

  // A seleção só vale para quem está na tela: ao buscar, trocar de filtro ou
  // recarregar, quem saiu da lista sai da seleção (nada de ação em massa às cegas).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = keepVisibleSelection(prev, filtered.map((c) => c.id));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const selectedClients = useMemo(() => filtered.filter((c) => selected.has(c.id)), [filtered, selected]);
  const allSelected = filtered.length > 0 && selectedClients.length === filtered.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  return (
    <div className="space-y-5 pb-4">
      <PageHeader
        title="Clientes"
        actions={
          <div className="flex gap-2">
            <Link href="/clientes/comunicacao" aria-label="Central de comunicação">
              <Button variant="secondary" size="sm">
                <MessageSquareText className="size-4" />
                <span className="hidden sm:inline">Mensagens</span>
              </Button>
            </Link>
            <Link href="/clientes/importar" aria-label="Importar clientes">
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

      <div className="space-y-2">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {SEGMENT_OPTIONS.map((s) => (
            <button
              key={s.value}
              onClick={() => setView(s.value)}
              className={cn(
                "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                view === s.value ? "bg-ink-800 text-cream" : "bg-ink-50 text-ink-600 hover:bg-ink-100"
              )}
            >
              {s.label}
            </button>
          ))}
          {/* Arquivadas é uma "visão" separada, não um segmento de relacionamento. */}
          <button
            onClick={() => setView("arquivadas")}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              view === "arquivadas"
                ? "border-ink-800 bg-ink-800 text-cream"
                : "border-ink-200 text-ink-500 hover:bg-ink-50"
            )}
          >
            <Archive className="size-3.5" />
            Inativas{archivedCount > 0 && ` (${archivedCount})`}
          </button>
        </div>
        {SEGMENT_HELP[view] && <p className="text-xs text-ink-400">{SEGMENT_HELP[view]}</p>}
      </div>

      {/* Aniversários — discreto, só aparece quando há alguém nos próximos 30 dias */}
      {!loading && birthdaysSoon.length > 0 && view === "todas" && !query && (
        <Card padding="sm">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
            <Cake className="size-3.5" />
            Aniversários próximos
          </div>
          <div className="space-y-1.5">
            {birthdaysSoon.map((c) => (
              <Link key={c.id} href={`/clientes/${c.id}`} className="flex items-center justify-between rounded-md py-1 hover:bg-ink-50">
                <span className="text-sm font-medium text-ink-800">{c.name}</span>
                <span className={cn("text-xs font-medium", c.daysToBirthday === 0 ? "text-gold-700" : "text-ink-400")}>
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
      ) : failed ? (
        <EmptyState
          icon={AlertCircle}
          title="Não foi possível carregar as clientes"
          description="Verifique sua conexão e tente novamente em instantes."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          art="pensativa"
          icon={query || view !== "todas" ? Search : Users}
          title={
            emptyBase && view === "arquivadas"
              ? "Nenhuma cliente inativa"
              : emptyBase
                ? "Ainda não há clientes cadastradas"
                : "Nenhuma cliente encontrada"
          }
          description={
            view === "arquivadas" && emptyBase
              ? "Quando você inativar uma cliente, ela aparece aqui."
              : emptyBase
                ? "Cadastre a primeira cliente para começar a preencher a agenda."
                : "Tente ajustar a busca ou o filtro."
          }
          action={
            emptyBase && view !== "arquivadas" ? (
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
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-400">
              {filtered.length} cliente{filtered.length > 1 ? "s" : ""}
            </p>
            {selecting ? (
              <div className="flex items-center gap-3 text-xs font-medium text-ink-500">
                <button
                  onClick={() => setSelected(allSelected ? new Set() : new Set(filtered.map((c) => c.id)))}
                  className="hover:text-ink-800"
                >
                  {allSelected ? "Limpar seleção" : filtered.length === 1 ? "Selecionar" : "Selecionar todas"}
                </button>
                <button onClick={stopSelecting} className="hover:text-ink-800">
                  Concluir
                </button>
              </div>
            ) : (
              <button
                onClick={() => setSelecting(true)}
                className="flex items-center gap-1.5 text-xs font-medium text-ink-500 hover:text-ink-800"
              >
                <ListChecks className="size-3.5" />
                Selecionar
              </button>
            )}
          </div>
          {filtered.map((c) => {
            const phoneText = phoneDisplay(c.phone, c.phone_normalized);
            const body = (
              <Card
                interactive
                className={cn("flex items-center gap-3", selecting && selected.has(c.id) && "ring-2 ring-ink-800")}
                padding="sm"
              >
                {selecting && (
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    aria-label={`Selecionar ${c.name}`}
                    className="size-4 shrink-0 accent-ink-800"
                  />
                )}
                <Avatar name={c.name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink-800">{c.name}</p>
                  <p className="truncate text-xs text-ink-400">
                    {phoneText ?? "Sem telefone"}
                    {c.last_visit_at && ` · última visita em ${formatDateOnly(c.last_visit_at)}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.archived_at && <Badge>Inativa</Badge>}
                  {!c.archived_at && c.isOverdue && (
                    <span title="Sem retorno dentro do padrão dela">
                      <AlertCircle className="size-4 text-warning" />
                    </span>
                  )}
                  {!c.archived_at && c.daysToBirthday !== null && c.daysToBirthday <= 7 && (
                    <span title={birthdayLabel(c.daysToBirthday)}>
                      <Cake className="size-4 text-gold-500" />
                    </span>
                  )}
                  {c.count > 0 && <span className="text-xs font-medium text-ink-400">{c.count} atend.</span>}
                </div>
              </Card>
            );
            // Em modo de seleção a linha inteira marca/desmarca (não abre a ficha).
            return selecting ? (
              <label key={c.id} className="block cursor-pointer">
                {body}
              </label>
            ) : (
              <Link key={c.id} href={`/clientes/${c.id}`}>
                {body}
              </Link>
            );
          })}
          {selecting && (
            <ClientesBulkActions
              selected={selectedClients}
              inactiveView={view === "arquivadas"}
              onClear={stopSelecting}
              onDone={reload}
            />
          )}
        </div>
      )}
    </div>
  );
}
