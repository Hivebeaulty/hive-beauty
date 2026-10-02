// Guard do painel SuperAdmin. O middleware só garante "está logada"; ele NÃO
// diferencia superadmin de usuária comum. Sem esta checagem, qualquer conta
// autenticada abria /admin e disparava consultas com service role (ignora RLS).
//
// Usa a função is_superadmin() do banco (migration 0001) com a sessão da própria
// usuária. Falha FECHADA: erro, null ou false -> redireciona para fora.
import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function requireSuperadmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("is_superadmin");
  if (error || data !== true) redirect("/inicio");
}
