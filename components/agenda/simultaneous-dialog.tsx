"use client";
// Pergunta antes de agendar mais de uma cliente no mesmo horário (migration 0053).
// Só aparece para quem ligou "Permitir mais de uma cliente no mesmo horário" nas Configurações.
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { overlapQuestion, type OverlapInfo } from "@/lib/hive/simultaneous";

export function SimultaneousDialog({
  open,
  existing,
  clientName,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  existing: OverlapInfo[];
  clientName: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const q = overlapQuestion(existing, clientName);
  return (
    <Modal open={open} onClose={() => !busy && onCancel()} title={q.title}>
      <div className="space-y-4" data-testid="simultaneous-dialog">
        <p className="text-sm text-ink-600">{q.body}</p>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
            Voltar
          </Button>
          <Button className="flex-1" onClick={onConfirm} loading={busy}>
            {busy ? "Salvando..." : "Agendar junto"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
