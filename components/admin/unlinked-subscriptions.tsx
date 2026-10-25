"use client";

// Assinaturas sem dona (0045): a cliente pagou, mas o Mercado Pago não informou o e-mail.
// Ligar a um e-mail é auditado; a mp-sync cria a conta e envia o e-mail de senha em até 5 min.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { fmtDate, formatBRL } from "@/lib/hive/admin";
import { MP_STATUS_LABEL, linkError, validateLink, type UnlinkedRow } from "@/lib/hive/admin-unlinked";
import { AlertCircle, AlertTriangle, Link2 } from "lucide-react";

function LinkButton({ row }: { row: UnlinkedRow }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const invalid = validateLink(email, reason);
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    const { error: err } = await createClient().rpc("admin_link_subscription", {
      p_preapproval_id: row.preapproval_id, p_email: email.trim(), p_reason: reason.trim(),
    });
    setBusy(false);
    if (err) return setError(linkError(err));
    toast.success("Assinatura ligada. Em até 5 minutos a conta é criada e a cliente recebe o e-mail de senha.");
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { setError(null); setOpen(true); }}>
        <Link2 className="size-4" /> {row.linked_email ? "Trocar e-mail" : "Ligar a um e-mail"}
      </Button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Ligar a assinatura a uma cliente">
        <div className="space-y-4 text-sm">
          <p className="text-ink-600">
            Use o e-mail da cliente que fez esta assinatura (confira no painel do Mercado Pago ou com ela).
            Em até 5 minutos a conta é criada (ou liberada, se já existir) e ela recebe o e-mail para criar a senha.
          </p>
          <Input label="E-mail da cliente" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Textarea label="Como você confirmou (fica na auditoria)" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button onClick={submit} disabled={busy} className="sm:flex-1">{busy ? "Ligando…" : "Ligar assinatura"}</Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy} className="sm:flex-1">Voltar</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function UnlinkedSubscriptions({ rows }: { rows: UnlinkedRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card className="border-warning/40">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-800">
        <AlertTriangle className="size-4 text-warning" /> Assinaturas sem dona ({rows.length})
      </h2>
      <p className="mt-1 text-sm text-ink-600">
        O Mercado Pago não informou o e-mail destas assinaturas e nenhuma conta correspondeu. A cliente pagou e ainda não tem acesso.
      </p>
      <ul className="mt-3 divide-y divide-ink-100">
        {rows.map((r) => (
          <li key={r.preapproval_id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-ink-800">{r.amount !== null ? formatBRL(r.amount) : "Valor não informado"} · {MP_STATUS_LABEL[r.mp_status ?? ""] ?? "Situação não informada"}</p>
              <p className="truncate text-xs text-ink-500">
                {r.preapproval_id} · criada em {r.date_created ? fmtDate(r.date_created) : "data não informada"}
              </p>
              {r.linked_email && <p className="mt-0.5 text-xs text-ink-600">Ligada a {r.linked_email}: aguardando a próxima sincronização.</p>}
            </div>
            <LinkButton row={r} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
