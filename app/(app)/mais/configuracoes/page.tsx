import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { ConfiguracoesContent } from "./configuracoes-content";

// Empresa, horário e equipe continuam só para owner/admin — o gate é reforçado
// aqui, no servidor (não só escondendo o link), porque business_hours é gravável
// por qualquer membro ativo via RLS; a tela não oferece esse caminho a quem não
// é administradora. "Como você quer ser chamada?" é PESSOAL e vale para todas:
// quem não é administradora vê só esse cartão.
export default async function ConfiguracoesPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  if (!membership) redirect("/mais");
  const isAdmin = membership.role === "owner" || membership.role === "admin";

  return <ConfiguracoesContent isAdmin={isAdmin} />;
}
