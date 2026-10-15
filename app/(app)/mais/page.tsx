import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { Card } from "@/components/ui/card";
import { LogoutButton } from "@/components/logout-button";
import { Scissors, BarChart3, Settings, ChevronRight } from "lucide-react";

// Só entram itens que já têm funcionalidade real por trás (regra do spec:
// não criar tela "porque sistema de gestão normalmente tem"). Relatórios e
// Relatórios são sensíveis e só aparecem pra owner/admin; Configurações aparece
// para todas (para quem não é admin, só "Como você quer ser chamada").
export default async function MaisPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  const isAdmin = membership?.role === "owner" || membership?.role === "admin";

  return (
    <div className="space-y-6 pb-4">
      <h1 className="page-title">Mais</h1>

      <div className="space-y-2">
        <Link href="/mais/servicos">
          <Card interactive className="flex items-center gap-3">
            <Scissors className="size-5 shrink-0 text-ink-400" />
            <div className="flex-1">
              <p className="font-semibold text-ink-800">Serviços</p>
              <p className="text-sm text-ink-400">Cadastre e organize o que você oferece.</p>
            </div>
            <ChevronRight className="size-4 shrink-0 text-ink-300" />
          </Card>
        </Link>

        {isAdmin && (
          <Link href="/mais/relatorios">
            <Card interactive className="flex items-center gap-3">
              <BarChart3 className="size-5 shrink-0 text-ink-400" />
              <div className="flex-1">
                <p className="font-semibold text-ink-800">Relatórios</p>
                <p className="text-sm text-ink-400">Indicadores do negócio por período.</p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-ink-300" />
            </Card>
          </Link>
        )}

        <Link href="/mais/configuracoes">
          <Card interactive className="flex items-center gap-3">
            <Settings className="size-5 shrink-0 text-ink-400" />
            <div className="flex-1">
              <p className="font-semibold text-ink-800">Configurações</p>
              <p className="text-sm text-ink-400">
                {isAdmin
                  ? "Seu nome, empresa, horário de funcionamento e equipe."
                  : "Como você quer ser chamada."}
              </p>
            </div>
            <ChevronRight className="size-4 shrink-0 text-ink-300" />
          </Card>
        </Link>
      </div>

      <div className="pt-2">
        <LogoutButton />
      </div>
    </div>
  );
}
