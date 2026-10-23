// Guard do painel SuperAdmin (0038). O middleware só garante "está logada".
// Aqui o BANCO responde (admin_whoami, com a sessão da própria usuária):
//   * não é superadmin            -> /inicio
//   * é superadmin, sem MFA (aal1) -> /admin-mfa (verificação em duas etapas)
// Falha FECHADA: erro, função ausente ou resposta estranha -> fora do painel.
//
// Isto protege as TELAS. Os DADOS são protegidos de novo no banco: toda função
// admin_* chama admin_assert() (superadmin + aal2) a cada chamada. O painel não
// usa service role: nenhuma chave privilegiada é necessária no servidor do app.
import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseWhoami } from "@/lib/hive/admin";

export async function requireSuperadmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("admin_whoami");
  const who = parseWhoami(error ? null : data);
  if (!who.isSuperadmin) redirect("/inicio");
  if (!who.mfaOk) redirect("/admin-mfa");
  return supabase;
}
