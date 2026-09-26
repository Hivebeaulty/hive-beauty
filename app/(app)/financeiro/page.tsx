import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { FinanceiroContent } from "./financeiro-content";

// Mesmo padrão do Configurações: RLS já bloqueia os dados pra quem não é
// owner/admin (payments/expenses são admin_only), mas em vez de deixar a
// tela renderizar vazia/confusa pra quem entra direto pela URL, redireciona.
// A segurança de verdade continua sendo a RLS, isso aqui é só UX.
export default async function FinanceiroPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  const isAdmin = membership?.role === "owner" || membership?.role === "admin";
  if (!isAdmin) redirect("/inicio");

  return <FinanceiroContent />;
}
