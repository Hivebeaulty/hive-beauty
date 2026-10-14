"use client";

// Situação da confirmação automática por WhatsApp (W5). Só desenho: o texto vem
// de describeConfirmation (lib/hive/whatsapp-confirmation.ts) e a regra, do banco.
import { MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ConfirmationView } from "@/lib/hive/whatsapp-confirmation";

export function WhatsappConfirmationStatus({ view }: { view: ConfirmationView }) {
  return (
    <div className="flex items-start gap-2.5 text-sm" role="status" data-testid="wa-confirmation">
      <MessageCircle className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <Badge tone={view.tone}>{view.label}</Badge>
        {view.detail && <p className="text-ink-500">{view.detail}</p>}
      </div>
    </div>
  );
}
