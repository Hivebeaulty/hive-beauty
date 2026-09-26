import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { DespesasContent } from "./despesas-content";

export default async function DespesasPage() {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);
  const isAdmin = membership?.role === "owner" || membership?.role === "admin";
  if (!isAdmin) redirect("/inicio");

  return <DespesasContent />;
}
