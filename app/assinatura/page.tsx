// Tela de assinatura inativa. Fica FORA do grupo (app): o layout de lá manda
// para cá quem não tem acesso, e esta página não pode passar pela mesma trava.
// Ela mesma reconsulta o banco (não confia em parâmetro na URL): se o acesso já
// foi liberado (ex.: pagou agora), volta sozinha para o app.
import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { accessCopy, parseAccess, CHECKOUT_URL } from "@/lib/hive/access";
import { LogoutButton } from "@/components/logout-button";
import { LegalLinks } from "@/components/legal-links";

export const dynamic = "force-dynamic";

export default async function AssinaturaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const membership = await getActiveMembership(supabase);
  const { data, error } = membership
    ? await supabase.rpc("get_company_access", { p_company_id: membership.companyId })
    : await supabase.rpc("get_my_access");
  const access = parseAccess(data, error);

  if (access.allowed) redirect(membership ? "/inicio" : "/onboarding");

  const isOwner = !membership || membership.role === "owner";
  const copy = accessCopy(access.status, isOwner);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cream px-6">
      <div className="w-full max-w-sm rounded-lg border border-ink-100 bg-surface p-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Image src="/logo-lockup.png" alt="Áurea" width={220} height={138} priority className="h-auto w-[180px] dark:hidden" />
          <Image src="/logo-lockup-dark.png" alt="Áurea" width={220} height={138} className="h-auto w-[180px] hidden dark:block" />
        </div>

        <h1 className="text-center text-lg font-semibold text-ink-800">{copy.title}</h1>
        <p className="mt-2 text-center text-sm text-ink-500">{copy.text}</p>

        {copy.canSubscribe && (
          <>
            <a href={CHECKOUT_URL} target="_blank" rel="noopener noreferrer"
               className="btn-gold mt-6 flex h-12 w-full items-center justify-center rounded px-5 text-base font-semibold">
              Assinar agora
            </a>
            {/* A liberação é pelo e-mail: o pagamento precisa sair com o MESMO e-mail da conta. */}
            <p className="mt-3 rounded-lg bg-sand px-4 py-3 text-xs text-ink-700">
              No Mercado Pago, use o mesmo e-mail desta conta: <strong className="break-all">{user.email}</strong>
            </p>
          </>
        )}

        <a href="/assinatura"
           className="mt-4 flex h-10 w-full items-center justify-center rounded border border-ink-200 bg-surface text-sm font-semibold text-ink-800 hover:bg-ink-50">
          {access.status === "error" ? "Tentar de novo" : access.status === "suspended" ? "Conferir de novo" : "Já assinei, conferir de novo"}
        </a>

        <LogoutButton variant="sidebar" className="mt-4 justify-center" />
        <LegalLinks className="mt-5" />
      </div>
    </main>
  );
}
