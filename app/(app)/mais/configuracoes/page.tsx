import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { ConfiguracoesContent } from "./configuracoes-content";

// Só owner/admin — mesmo critério já usado pra Financeiro/Relatórios. Aqui
// o gate é reforçado na própria página (não só escondendo o link) porque
// business_hours é gravável por qualquer membro ativo via RLS; a tela não
// deve oferecer esse caminho pra quem não é administradora.
export default async function ConfiguracoesPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  const isAdmin = membership?.role === "owner" || membership?.role === "admin";
  if (!isAdmin) redirect("/mais");

  return <ConfiguracoesContent />;
}
