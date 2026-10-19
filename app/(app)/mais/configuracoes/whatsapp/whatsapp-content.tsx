"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useCompany } from "@/components/company-provider";
import { WhatsappPanel } from "@/components/settings/whatsapp-panel";
import { WhatsappAutoConfirmation } from "@/components/settings/whatsapp-auto-confirmation";
import { WhatsappConfirmationTemplate } from "@/components/settings/whatsapp-confirmation-template";
import { WhatsappBirthdayMessage } from "@/components/settings/whatsapp-birthday-message";
import { WhatsappAutoMessages } from "@/components/settings/whatsapp-auto-messages";

export function WhatsappContent() {
  const { companyId, companyName, role } = useCompany();

  return (
    <div className="space-y-5 pb-4">
      <Link
        href="/mais/configuracoes"
        className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800"
      >
        <ChevronLeft className="size-4" />
        Configurações
      </Link>

      <div>
        <h1 className="page-title">WhatsApp</h1>
        <p className="mt-1 text-sm text-ink-500">Conexão do número de WhatsApp da empresa com a Áurea.</p>
      </div>

      <WhatsappPanel companyId={companyId} role={role} />

      <WhatsappAutoConfirmation companyId={companyId} />

      <WhatsappConfirmationTemplate companyId={companyId} companyName={companyName ?? ""} />

      <WhatsappBirthdayMessage companyId={companyId} companyName={companyName ?? ""} />

      <WhatsappAutoMessages companyId={companyId} companyName={companyName ?? ""} />
    </div>
  );
}
