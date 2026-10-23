"use client";

// Ações da ficha da conta. A tela só coleta o pedido: quem autoriza, executa e
// registra na auditoria é o BANCO (admin_set_suspension / admin_add_note).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { AlertCircle, Ban, RotateCcw } from "lucide-react";

function messageFor(e: { code?: string; message?: string }) {
  if (e.code === "AUA01") return "Sua verificação em duas etapas expirou. Recarregue a página para confirmar de novo.";
  if (e.code === "42501") return "Sua conta não tem permissão para esta ação.";
  if (e.code === "22023" || e.code === "P0002") return e.message ?? "Dados inválidos.";
  return "Não foi possível concluir. Tente de novo.";
}

export function SuspensionControl({ companyId, companyName, suspended }: { companyId: string; companyName: string; suspended: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suspend = !suspended;

  async function submit() {
    if (reason.trim().length < 5) return setError("Escreva o motivo (pelo menos 5 caracteres).");
    setBusy(true);
    setError(null);
    const { error: e } = await createClient().rpc("admin_set_suspension", {
      p_company_id: companyId,
      p_suspend: suspend,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (e) return setError(messageFor(e));
    toast.success(suspend ? `Acesso de ${companyName} suspenso.` : `Acesso de ${companyName} reativado.`);
    setOpen(false);
    setReason("");
    router.refresh();
  }

  return (
    <>
      <Button variant={suspend ? "secondary" : "primary"} size="sm" onClick={() => { setError(null); setOpen(true); }}>
        {suspend ? <Ban className="size-4" /> : <RotateCcw className="size-4" />}
        {suspend ? "Suspender acesso" : "Reativar acesso"}
      </Button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title={suspend ? "Suspender o acesso" : "Reativar o acesso"}>
        <div className="space-y-4 text-sm">
          {suspend ? (
            <ul className="list-disc space-y-1 pl-5 text-ink-600">
              <li>A dona e a equipe de <strong>{companyName}</strong> deixam de entrar no app e veem o aviso de acesso suspenso.</li>
              <li>Nada é apagado: agenda, clientes e financeiro ficam guardados.</li>
              <li>A assinatura no Mercado Pago <strong>não</strong> é cancelada: se ela paga, a cobrança continua.</li>
              <li>Mensagens automáticas de WhatsApp já agendadas não são interrompidas por esta ação.</li>
            </ul>
          ) : (
            <p className="text-ink-600">
              O acesso volta a seguir a assinatura de <strong>{companyName}</strong>. Nenhuma cobrança é criada ou alterada.
            </p>
          )}
          <Textarea
            label="Motivo (fica registrado na auditoria)"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button variant={suspend ? "danger" : "primary"} onClick={submit} disabled={busy} className="sm:flex-1">
              {busy ? "Salvando…" : suspend ? "Suspender acesso" : "Reativar acesso"}
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

export function NoteForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!body.trim()) return setError("Escreva a observação.");
    setBusy(true);
    setError(null);
    const { error: e } = await createClient().rpc("admin_add_note", { p_company_id: companyId, p_body: body.trim() });
    setBusy(false);
    if (e) return setError(messageFor(e));
    setBody("");
    toast.success("Observação registrada.");
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <Textarea
        label="Nova observação"
        hint="Visível só para a administração da Áurea."
        rows={2}
        maxLength={2000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button size="sm" variant="secondary" onClick={save} disabled={busy}>
        {busy ? "Salvando…" : "Registrar observação"}
      </Button>
    </div>
  );
}
