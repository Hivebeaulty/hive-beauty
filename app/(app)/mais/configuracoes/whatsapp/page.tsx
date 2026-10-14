import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { WhatsappContent } from "./whatsapp-content";

// Status visível para qualquer membro ativo; conectar, ver o QR e desconectar
// só para owner/admin — regra garantida pelas RPCs da 0017 (no banco), não
// só pela tela.
export default async function WhatsappPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  if (!membership) redirect("/mais");
  return <WhatsappContent />;
}
