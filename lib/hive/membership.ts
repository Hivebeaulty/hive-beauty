// Busca a empresa/vínculo ativo do usuário logado. Assume 1 empresa por
// usuário no MVP (o fluxo de onboarding só cria uma). Funciona com qualquer
// client Supabase (browser ou server) pois depende só da sessão do usuário.
import type { SupabaseClient } from "@supabase/supabase-js";

export type Membership = {
  companyId: string;
  memberId: string;
  role: "owner" | "admin" | "professional" | "reception";
  companyName: string;
};

export async function getActiveMembership(
  supabase: SupabaseClient
): Promise<Membership | null> {
  const { data, error } = await supabase
    .from("company_members")
    .select("id, company_id, role, companies(name)")
    .eq("active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const companies = data.companies as unknown as { name: string } | { name: string }[] | null;
  const companyName = Array.isArray(companies) ? companies[0]?.name : companies?.name;

  return {
    companyId: data.company_id,
    memberId: data.id,
    role: data.role,
    companyName: companyName ?? "",
  };
}
