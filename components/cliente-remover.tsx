"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Archive, ArchiveRestore, Trash2, AlertTriangle } from "lucide-react";

type Summary = { appointments: number; upcoming: number; payments: number };

// Regra única, decidida pelo BANCO (RPC get_client_history_summary, que enxerga
// pagamentos mesmo para quem não tem acesso ao financeiro):
//   - sem atendimentos e sem pagamentos  -> exclusão definitiva
//   - com qualquer histórico             -> arquivar (nada é apagado)
export function ClienteRemover({
  clientId,
  clientName,
  archived,
}: {
  clientId: string;
  clientName: string;
  archived: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const hasHistory = summary ? summary.appointments > 0 || summary.payments > 0 : false;

  async function openModal() {
    setOpen(true);
    setSummary(null);
    setLoadFailed(false);
    setLoading(true);
    const { data, error } = await createClient().rpc("get_client_history_summary", { p_client_id: clientId });
    setLoading(false);
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      setLoadFailed(true);
      return;
    }
    setSummary({
      appointments: Number(row.appointments_total),
      upcoming: Number(row.appointments_upcoming),
      payments: Number(row.payments_total),
    });
  }

  async function archive() {
    setWorking(true);
    // .select("id"): a RLS pode filtrar a linha SEM devolver erro; só vale como
    // sucesso se uma linha realmente foi atualizada.
    const { data, error } = await createClient()
      .from("clients")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", clientId)
      .select("id");
    setWorking(false);
    if (error || !data || data.length === 0) {
      toast.error("Não foi possível arquivar. Tente novamente.");
      return;
    }
    toast.success(`${clientName} foi arquivada.`);
    setOpen(false);
    router.push("/clientes");
    router.refresh();
  }

  async function remove() {
    setWorking(true);
    const { error } = await createClient().rpc("delete_client_without_history", { p_client_id: clientId });
    setWorking(false);
    if (error) {
      // 23503: ganhou histórico enquanto a janela estava aberta — o banco recusou.
      toast.error(
        error.code === "23503"
          ? "Esta cliente já tem histórico e não pode ser excluída. Arquive-a."
          : "Não foi possível excluir. Tente novamente."
      );
      setOpen(false);
      router.refresh();
      return;
    }
    toast.success("Cliente excluída.");
    setOpen(false);
    router.push("/clientes");
    router.refresh();
  }

  async function reactivate() {
    setWorking(true);
    const { data, error } = await createClient()
      .from("clients")
      .update({ archived_at: null })
      .eq("id", clientId)
      .select("id");
    setWorking(false);
    if (error || !data || data.length === 0) {
      toast.error("Não foi possível reativar. Tente novamente.");
      return;
    }
    toast.success(`${clientName} foi reativada.`);
    router.refresh();
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
        {archived && (
          <Button variant="secondary" size="sm" onClick={reactivate} loading={working}>
            <ArchiveRestore className="size-4" />
            Reativar cliente
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={openModal} className="text-ink-500">
          <Trash2 className="size-4" />
          {archived ? "Excluir cliente" : "Excluir ou arquivar"}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => !working && setOpen(false)}
        title={loading || !summary ? "Remover cliente" : hasHistory ? "Arquivar cliente" : "Excluir cliente"}
      >
        {loading && <p className="text-sm text-ink-400">Verificando o histórico de {clientName}...</p>}

        {loadFailed && (
          <div className="space-y-4">
            <p className="text-sm text-ink-700">Não foi possível verificar o histórico agora. Tente novamente em instantes.</p>
            <Button variant="secondary" className="w-full" onClick={() => setOpen(false)}>
              Fechar
            </Button>
          </div>
        )}

        {summary && !hasHistory && (
          <div className="space-y-4">
            <p className="text-sm text-ink-700">
              <strong className="font-semibold">{clientName}</strong> não tem atendimentos nem pagamentos registrados.
            </p>
            <div className="flex items-start gap-2.5 rounded-lg bg-danger/10 px-3.5 py-3 text-sm text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>Ela será excluída definitivamente. Esta ação não pode ser desfeita.</span>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)} disabled={working}>
                Cancelar
              </Button>
              <Button variant="danger" className="flex-1" onClick={remove} loading={working}>
                Excluir definitivamente
              </Button>
            </div>
          </div>
        )}

        {summary && hasHistory && !archived && (
          <div className="space-y-4">
            <p className="text-sm text-ink-700">
              <strong className="font-semibold">{clientName}</strong> tem histórico ({describeHistory(summary)}). Por isso
              ela não pode ser excluída — vamos arquivá-la.
            </p>
            <ul className="space-y-1.5 text-sm text-ink-500">
              <li>Ela deixa de aparecer na lista principal de clientes.</li>
              <li>O histórico de agenda e o financeiro continuam intactos.</li>
              <li>Você pode encontrá-la no filtro &ldquo;Arquivadas&rdquo; e reativá-la quando quiser.</li>
            </ul>
            {summary.upcoming > 0 && (
              <div className="flex items-start gap-2.5 rounded-lg border border-gold-300 bg-gold-50 px-3.5 py-3 text-sm text-ink-700">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-gold-700" />
                <span>
                  Ela tem {summary.upcoming} atendimento{summary.upcoming > 1 ? "s" : ""} agendado
                  {summary.upcoming > 1 ? "s" : ""} pela frente. Arquivar não cancela esses horários.
                </span>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)} disabled={working}>
                Cancelar
              </Button>
              <Button className="flex-1" onClick={archive} loading={working}>
                <Archive className="size-4" />
                Arquivar
              </Button>
            </div>
          </div>
        )}

        {summary && hasHistory && archived && (
          <div className="space-y-4">
            <p className="text-sm text-ink-700">
              <strong className="font-semibold">{clientName}</strong> já está arquivada e tem histórico ({describeHistory(summary)}),
              então não pode ser excluída definitivamente. O histórico fica preservado.
            </p>
            <Button variant="secondary" className="w-full" onClick={() => setOpen(false)}>
              Entendi
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}

function describeHistory(s: Summary) {
  const parts: string[] = [];
  if (s.appointments > 0) parts.push(`${s.appointments} atendimento${s.appointments > 1 ? "s" : ""}`);
  if (s.payments > 0) parts.push(`${s.payments} pagamento${s.payments > 1 ? "s" : ""}`);
  return parts.join(" e ");
}
