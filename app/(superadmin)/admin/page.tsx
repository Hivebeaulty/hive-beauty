import { createAdminClient } from "@/lib/supabase/admin";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";

// Toda leitura cross-tenant do SuperAdmin passa pelo cliente com service role,
// que só existe no servidor — nunca chega ao navegador. O acesso a esta rota
// em si é protegido por requireSuperadmin() (is_superadmin() no banco).
export default async function AdminHomePage() {
  await requireSuperadmin();
  const admin = createAdminClient();
  const { count: companiesCount } = await admin
    .from("companies")
    .select("*", { count: "exact", head: true });

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <div className="rounded-2xl bg-white/5 p-5">
        <p className="text-3xl font-bold">{companiesCount ?? "—"}</p>
        <p className="text-sm text-white/60">Empresas cadastradas</p>
      </div>
    </div>
  );
}
