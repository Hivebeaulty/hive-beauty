// Verificação em duas etapas do painel. Fica FORA de app/(superadmin)/admin para
// não cair na própria trava. Só superadmin chega aqui; quem já está com MFA vai
// direto para o painel.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseWhoami } from "@/lib/hive/admin";
import { AdminMfa } from "@/components/admin/admin-mfa";

export const dynamic = "force-dynamic";

export default async function AdminMfaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await supabase.rpc("admin_whoami");
  const who = parseWhoami(error ? null : data);
  if (!who.isSuperadmin) redirect("/inicio");
  if (who.mfaOk) redirect("/admin");

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-6 py-10">
      <div className="w-full max-w-sm rounded-lg border border-ink-100 bg-surface p-7">
        <h1 className="text-lg font-semibold text-ink-800">Verificação em duas etapas</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          O painel administrativo mostra dados de todas as contas. Para entrar, confirme com o código do seu aplicativo autenticador.
        </p>
        <AdminMfa email={user.email ?? ""} />
      </div>
    </main>
  );
}
