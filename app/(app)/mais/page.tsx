import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";

// Só entram itens que já têm funcionalidade real por trás (regra do spec:
// não criar tela "porque sistema de gestão normalmente tem"). Relatórios é
// sensível (mesmos dados do Financeiro) e só aparece pra owner/admin.
export default async function MaisPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  const canSeeReports = membership?.role === "owner" || membership?.role === "admin";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-charcoal-900">Mais</h1>

      <Link
        href="/mais/servicos"
        className="block rounded-2xl bg-white p-5 shadow-sm transition hover:bg-blush-50"
      >
        <p className="font-semibold text-charcoal-900">Serviços</p>
        <p className="text-sm text-charcoal-700">Cadastre e organize o que você oferece.</p>
      </Link>

      {canSeeReports && (
        <Link
          href="/mais/relatorios"
          className="block rounded-2xl bg-white p-5 shadow-sm transition hover:bg-blush-50"
        >
          <p className="font-semibold text-charcoal-900">Relatórios</p>
          <p className="text-sm text-charcoal-700">Indicadores do negócio por período.</p>
        </Link>
      )}

      <p className="text-center text-xs text-charcoal-500">
        Equipe, Empresa e Configurações chegam nas próximas fases.
      </p>
    </div>
  );
}
