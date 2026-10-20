"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ClientRow } from "@/lib/hive/clients-data";
import {
  BULK_CHUNK,
  chunk,
  mapWithLimit,
  planBulkDelete,
  plural,
  type DeletePlan,
  type HistoryInfo,
} from "@/lib/hive/bulk-clients";
import { AlertTriangle, ArchiveRestore, Trash2, UserX, X } from "lucide-react";

type Mode = "inativar" | "excluir" | "reativar";

const noun = (n: number) => plural(n, "cliente", "clientes");

// Barra de ações da seleção múltipla da lista de Clientes. As regras são as
// mesmas da tela de uma cliente só (components/cliente-remover.tsx):
//   - inativar  = preenche archived_at (nada é apagado, é reversível);
//   - excluir   = definitivo SÓ para quem não tem atendimentos nem pagamentos;
//                 quem tem histórico é inativada (e o banco continua recusando
//                 qualquer exclusão com histórico, mesmo que a tela errasse).
export function ClientesBulkActions({
  selected,
  inactiveView,
  onClear,
  onDone,
}: {
  selected: ClientRow[];
  // true = lista de Inativas (a ação principal passa a ser Reativar)
  inactiveView: boolean;
  onClear: () => void;
  // chamada depois de qualquer alteração, para recarregar a lista
  onDone: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode | null>(null);
  const [working, setWorking] = useState(false);
  // inativar: quantas têm atendimento marcado pela frente (aviso, não bloqueia)
  const [upcoming, setUpcoming] = useState<{ clients: number; appointments: number } | null>(null);
  // excluir: o que o banco diz sobre o histórico de cada uma
  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [unverified, setUnverified] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  const count = selected.length;
  const ids = selected.map((c) => c.id);

  function close() {
    if (working) return;
    setMode(null);
  }

  async function openInativar() {
    setUpcoming(null);
    setMode("inativar");
    // Aviso de agendamentos futuros. Se a consulta falhar, o aviso só não aparece.
    const supabase = createClient();
    const withUpcoming = new Set<string>();
    let appointments = 0;
    for (const part of chunk(ids)) {
      const { data, error } = await supabase
        .from("appointments")
        .select("client_id")
        .in("client_id", part)
        .in("status", ["agendado", "confirmado"])
        .gte("scheduled_start", new Date().toISOString());
      if (error) return;
      for (const a of data ?? []) {
        withUpcoming.add(a.client_id);
        appointments += 1;
      }
    }
    setUpcoming({ clients: withUpcoming.size, appointments });
  }

  async function openExcluir() {
    setPlan(null);
    setUnverified(0);
    setConfirmed(false);
    setMode("excluir");
    setChecking(true);
    const supabase = createClient();
    const infos = await mapWithLimit(selected, 6, async (c): Promise<HistoryInfo | null> => {
      const { data, error } = await supabase.rpc("get_client_history_summary", { p_client_id: c.id });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) return null;
      return {
        id: c.id,
        archived: !!c.archived_at,
        appointments: Number(row.appointments_total),
        payments: Number(row.payments_total),
      };
    });
    const known = infos.filter((i): i is HistoryInfo => i !== null);
    setUnverified(infos.length - known.length);
    setPlan(planBulkDelete(known));
    setChecking(false);
  }

  // Devolve quantas linhas realmente mudaram. `.select("id")`: a RLS pode filtrar
  // linhas sem dar erro, então só conta o que o banco confirmou. O filtro de
  // archived_at garante que só muda quem ainda está no estado que a tela mostrou.
  async function setArchived(target: string[], archive: boolean): Promise<{ changed: number; failed: boolean }> {
    const supabase = createClient();
    let changed = 0;
    for (const part of chunk(target, BULK_CHUNK)) {
      let query = supabase
        .from("clients")
        .update({ archived_at: archive ? new Date().toISOString() : null })
        .in("id", part);
      query = archive ? query.is("archived_at", null) : query.not("archived_at", "is", null);
      const { data, error } = await query.select("id");
      if (error) return { changed, failed: true };
      changed += data?.length ?? 0;
    }
    return { changed, failed: false };
  }

  async function finish(messages: { ok?: string; warn?: string }) {
    setMode(null);
    onClear();
    if (messages.warn) toast.error(messages.warn);
    else if (messages.ok) toast.success(messages.ok);
    await onDone();
  }

  async function runInativar() {
    setWorking(true);
    const { changed, failed } = await setArchived(ids, true);
    setWorking(false);
    if (failed) {
      await finish({
        warn:
          changed > 0
            ? `Só ${changed} de ${count} ${noun(count)} foram inativadas. Tente novamente com as demais.`
            : "Não foi possível inativar. Tente novamente.",
      });
      return;
    }
    await finish({
      ok:
        changed === count
          ? `${changed} ${noun(changed)} ${plural(changed, "inativada", "inativadas")}. Elas não recebem mais mensagens automáticas e não aparecem para novos agendamentos.`
          : `${changed} de ${count} ${noun(count)} inativadas. As demais já tinham mudado.`,
    });
  }

  async function runReativar() {
    setWorking(true);
    const { changed, failed } = await setArchived(ids, false);
    setWorking(false);
    if (failed) {
      await finish({
        warn:
          changed > 0
            ? `Só ${changed} de ${count} ${noun(count)} foram reativadas. Tente novamente com as demais.`
            : "Não foi possível reativar. Tente novamente.",
      });
      return;
    }
    await finish({ ok: `${changed} ${noun(changed)} ${plural(changed, "reativada", "reativadas")}.` });
  }

  async function runExcluir() {
    if (!plan) return;
    setWorking(true);
    const supabase = createClient();
    let deleted = 0;
    let failedDeletes = 0;
    // 23503: ganhou histórico depois da verificação — o banco recusou, então vira inativa.
    const gainedHistory: string[] = [];
    await mapWithLimit(plan.toDelete, 4, async (id: string) => {
      const { error } = await supabase.rpc("delete_client_without_history", { p_client_id: id });
      if (!error) deleted += 1;
      else if (error.code === "23503") gainedHistory.push(id);
      else failedDeletes += 1;
    });
    const toInactivate = [...plan.toInactivate, ...gainedHistory];
    let inactivated = 0;
    let inactivateFailed = false;
    if (toInactivate.length > 0) {
      const r = await setArchived(toInactivate, true);
      inactivated = r.changed;
      inactivateFailed = r.failed;
    }
    setWorking(false);

    const parts: string[] = [];
    if (deleted > 0) parts.push(`${deleted} ${plural(deleted, "excluída", "excluídas")}`);
    if (inactivated > 0) parts.push(`${inactivated} ${plural(inactivated, "inativada", "inativadas")} (tinham histórico)`);
    const problems = failedDeletes + (inactivateFailed ? toInactivate.length - inactivated : 0);
    if (problems > 0) {
      await finish({
        warn: `${parts.length ? parts.join(" · ") + ". " : ""}${problems} ${noun(problems)} não ${plural(problems, "pôde", "puderam")} ser ${plural(problems, "alterada", "alteradas")}. Tente novamente.`,
      });
      return;
    }
    await finish({ ok: parts.length ? `${parts.join(" · ")}.` : "Nada foi alterado." });
  }

  const nothingToDo = !!plan && plan.toDelete.length === 0 && plan.toInactivate.length === 0;

  return (
    <>
      <div
        className="sticky bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] z-20 md:bottom-4"
        role="region"
        aria-label="Ações para as clientes selecionadas"
        data-testid="bulk-bar"
      >
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-200 bg-surface p-2.5 pl-4 shadow-float">
          <p className="mr-auto text-sm font-semibold text-ink-800" aria-live="polite">
            {count} {plural(count, "selecionada", "selecionadas")}
          </p>
          {inactiveView ? (
            <Button size="sm" variant="secondary" disabled={count === 0} onClick={() => setMode("reativar")}>
              <ArchiveRestore className="size-4" />
              Reativar
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={count === 0} onClick={openInativar}>
              <UserX className="size-4" />
              Inativar
            </Button>
          )}
          <Button size="sm" variant="danger" disabled={count === 0} onClick={openExcluir}>
            <Trash2 className="size-4" />
            Excluir
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} aria-label="Cancelar seleção">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Inativar */}
      <Modal open={mode === "inativar"} onClose={close} title={`Inativar ${count} ${noun(count)}`}>
        <div className="space-y-4" data-testid="bulk-inativar">
          <p className="text-sm text-ink-600">
            {count === 1 ? "A cliente selecionada vai" : `As ${count} clientes selecionadas vão`} para a lista de{" "}
            <strong className="font-semibold">Inativas</strong>:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-600">
            <li>não aparecem para novos agendamentos;</li>
            <li>não recebem mensagens automáticas (aniversário, datas comemorativas, Central);</li>
            <li>o histórico e os recebimentos continuam guardados;</li>
            <li>você pode reativá-las quando quiser.</li>
          </ul>
          {upcoming && upcoming.appointments > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {upcoming.clients} {plural(upcoming.clients, "delas tem", "delas têm")} {upcoming.appointments}{" "}
              {plural(upcoming.appointments, "agendamento", "agendamentos")} pela frente. Inativar não cancela esses horários, mas
              os lembretes deixam de ser enviados.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={working}>
              Cancelar
            </Button>
            <Button onClick={runInativar} loading={working}>
              Inativar {count}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Reativar */}
      <Modal open={mode === "reativar"} onClose={close} title={`Reativar ${count} ${noun(count)}`}>
        <div className="space-y-4" data-testid="bulk-reativar">
          <p className="text-sm text-ink-600">
            {count === 1 ? "A cliente volta" : `As ${count} clientes voltam`} para a lista principal, para os agendamentos e para as
            mensagens automáticas.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={working}>
              Cancelar
            </Button>
            <Button onClick={runReativar} loading={working}>
              Reativar {count}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Excluir */}
      <Modal open={mode === "excluir"} onClose={close} title={`Excluir ${count} ${noun(count)}`}>
        <div className="space-y-4" data-testid="bulk-excluir">
          {checking && <p className="text-sm text-ink-400">Verificando o histórico de cada cliente...</p>}

          {plan && (
            <>
              {plan.toDelete.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-ink-700">
                    <strong className="font-semibold">{plan.toDelete.length}</strong>{" "}
                    {plural(plan.toDelete.length, "cliente não tem", "clientes não têm")} atendimentos nem pagamentos e{" "}
                    {plural(plan.toDelete.length, "será excluída", "serão excluídas")} definitivamente.
                  </p>
                  <div className="flex items-start gap-2.5 rounded-lg bg-danger/10 px-3.5 py-3 text-sm text-danger">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>Esta ação não pode ser desfeita.</span>
                  </div>
                </div>
              )}

              {plan.toInactivate.length > 0 && (
                <p className="text-sm text-ink-700">
                  <strong className="font-semibold">{plan.toInactivate.length}</strong>{" "}
                  {plural(plan.toInactivate.length, "cliente tem", "clientes têm")} histórico e não{" "}
                  {plural(plan.toInactivate.length, "pode", "podem")} ser {plural(plan.toInactivate.length, "excluída", "excluídas")}:{" "}
                  {plural(plan.toInactivate.length, "ela será inativada", "elas serão inativadas")}. O histórico e o financeiro
                  continuam intactos e você pode reativá-
                  {plural(plan.toInactivate.length, "la", "las")} depois.
                </p>
              )}

              {plan.untouched.length > 0 && (
                <p className="text-sm text-ink-500">
                  {plan.untouched.length} {plural(plan.untouched.length, "já está inativa e tem", "já estão inativas e têm")} histórico:
                  fica{plural(plan.untouched.length, "", "m")} como {plural(plan.untouched.length, "está", "estão")}.
                </p>
              )}

              {unverified > 0 && (
                <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  Não foi possível verificar o histórico de {unverified} {noun(unverified)}. {plural(unverified, "Ela", "Elas")} não{" "}
                  {plural(unverified, "será alterada", "serão alteradas")} agora.
                </p>
              )}

              {nothingToDo && <p className="text-sm text-ink-700">Nada para alterar nesta seleção.</p>}

              {plan.toDelete.length > 0 && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-ink-200 p-3 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5 size-4 shrink-0 accent-ink-800"
                  />
                  <span>
                    Entendo que {plural(plan.toDelete.length, "a exclusão é definitiva", "as exclusões são definitivas")}.
                  </span>
                </label>
              )}
            </>
          )}

          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={close} disabled={working}>
              {nothingToDo ? "Fechar" : "Cancelar"}
            </Button>
            {plan && !nothingToDo && (
              <Button
                variant={plan.toDelete.length > 0 ? "danger" : "primary"}
                className="flex-1"
                onClick={runExcluir}
                loading={working}
                disabled={plan.toDelete.length > 0 && !confirmed}
              >
                {plan.toDelete.length > 0 ? "Confirmar" : `Inativar ${plan.toInactivate.length}`}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
