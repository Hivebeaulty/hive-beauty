"use client";

import Link from "next/link";
import { useCompany } from "@/components/company-provider";
import { ProfileNameCard } from "@/components/settings/profile-name-card";
import { CompanyNameCard } from "@/components/settings/company-name-card";
import { BusinessHoursCard } from "@/components/settings/business-hours-card";
import { TeamCard } from "@/components/settings/team-card";
import { Card } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";

export function ConfiguracoesContent({ isAdmin }: { isAdmin: boolean }) {
  const { companyId, memberId } = useCompany();

  return (
    <div className="space-y-5 pb-4">
      <Link href="/mais" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Mais
      </Link>

      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Configurações</h1>

      <ProfileNameCard />

      {/* WhatsApp: todas veem o status; conectar e desconectar só a administração */}
      <Link href="/mais/configuracoes/whatsapp">
        <Card interactive className="flex items-center gap-3">
          <MessageCircle className="size-5 shrink-0 text-ink-400" />
          <div className="flex-1">
            <p className="font-semibold text-ink-800">WhatsApp</p>
            <p className="text-sm text-ink-400">
              {isAdmin ? "Conecte o número de WhatsApp da empresa." : "Veja se o WhatsApp da empresa está conectado."}
            </p>
          </div>
          <ChevronRight className="size-4 shrink-0 text-ink-300" />
        </Card>
      </Link>
      {isAdmin && (
        <>
          <CompanyNameCard companyId={companyId} />
          <BusinessHoursCard companyId={companyId} />
          <TeamCard companyId={companyId} currentMemberId={memberId} />
        </>
      )}
    </div>
  );
}
