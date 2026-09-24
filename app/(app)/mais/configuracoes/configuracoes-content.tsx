"use client";

import Link from "next/link";
import { useCompany } from "@/components/company-provider";
import { CompanyNameCard } from "@/components/settings/company-name-card";
import { BusinessHoursCard } from "@/components/settings/business-hours-card";
import { TeamCard } from "@/components/settings/team-card";
import { ChevronLeft } from "lucide-react";

export function ConfiguracoesContent() {
  const { companyId, memberId } = useCompany();

  return (
    <div className="space-y-5 pb-4">
      <Link href="/mais" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Mais
      </Link>

      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Configurações</h1>

      <CompanyNameCard companyId={companyId} />
      <BusinessHoursCard companyId={companyId} />
      <TeamCard companyId={companyId} currentMemberId={memberId} />
    </div>
  );
}
