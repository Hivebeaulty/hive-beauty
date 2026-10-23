"use client";

// Ações que falam com o Mercado Pago. O navegador só chama a função admin-billing
// com a sessão (MFA) da superadmin; o token do Mercado Pago fica no servidor.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { billingActionError } from "@/lib/hive/admin-finance";
import { AlertCircle, RefreshCw, XCircle } from "lucide-react";

async function callBilling(body: Record<string, unknown>) {
  const { data, error } = await createClient().functions.invoke("admin-billing", { body });
  if (!error) return { ok: true as const, data: data as Record<string, unknown> };
  // Erro HTTP da função: lê o corpo para mostrar o motivo real.
  const res = (error as { context?: Response }).context;
  let parsed: { error?: string; detail?: string; code?: string } | null = null;
  try { parsed = res ? await res.json() : null; } catch { parsed = null; }
  return { ok: false as const, message: billingActionError(res?.status ?? 0, parsed) };
}

export function CancelSubscription({ companyId, companyName, courtesy }: { companyId: string; companyName: string; courtesy: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (reason.trim().length < 5) return setError("Escreva o motivo (pelo menos 5 caracteres).");
    setBusy(true);
    setError(null);
    const r = await callBilling({ action: "cancel", company_id: companyId, reason: reason.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    toast.success(`Assinatura de ${companyName} cancelada no Mercado Pago.`);
    setOpen(false);
    setReason("");
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { setError(null); setOpen(true); }}>
        <XCircle className="size-4" /> Cancelar assinatura
      </Button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Cancelar a assinatura">
        <div className="space-y-4 text-sm">
          <ul className="list-disc space-y-1 pl-5 text-ink-600">
            <li>A assinatura de <strong className="text-ink-800">{companyName}</strong> é cancelada <strong className="text-ink-800">no Mercado Pago</strong>: não haverá novas cobranças.</li>
            <li>Isso não pode ser desfeito pelo painel. Para voltar, ela precisa assinar de novo.</li>
            <li>Cobranças já feitas não são reembolsadas por esta ação.</li>
            {courtesy ? (
              <li>A conta é cortesia: o acesso ao app continua liberado.</li>
            ) : (
              <li>O acesso ao app continua até o fim do período já pago. Se ela ainda estiver no teste grátis, é bloqueado assim que o Mercado Pago confirmar. Nenhum dado é apagado.</li>
            )}
          </ul>
          <Textarea label="Motivo (fica registrado na auditoria)" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button variant="danger" onClick={submit} disabled={busy} className="sm:flex-1">
              {busy ? "Cancelando no Mercado Pago…" : "Cancelar assinatura"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy} className="sm:flex-1">
              Voltar
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function ReconcileButton() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const r = await callBilling({ action: "reconcile" });
    setBusy(false);
    if (!r.ok) return setResult(r.message);
    const d = r.data as { checked?: number; payments?: number; errors?: number };
    const msg = `${d.checked ?? 0} assinaturas e ${d.payments ?? 0} cobranças conferidas${d.errors ? `, ${d.errors} com erro (veja a auditoria)` : ""}.`;
    d.errors ? setResult(msg) : toast.success(msg);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button variant="secondary" size="sm" onClick={run} disabled={busy}>
        <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
        {busy ? "Conferindo com o Mercado Pago…" : "Conferir com o Mercado Pago"}
      </Button>
      {result && <p role="status" className="flex items-center gap-1.5 text-xs text-ink-700"><AlertCircle className="size-3.5 shrink-0 text-warning" />{result}</p>}
    </div>
  );
}
