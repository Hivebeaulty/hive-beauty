import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { parseAccess, formatUntil, CHECKOUT_URL } from "@/lib/hive/access";
import { CompanyProvider } from "@/components/company-provider";
import { AppNav, type NavItem } from "@/components/app-nav";
import { MobileHeader } from "@/components/mobile-header";

const NAV_ITEMS: NavItem[] = [
  { href: "/inicio", label: "Início" },
  { href: "/agenda", label: "Agenda" },
  { href: "/clientes", label: "Clientes" },
  { href: "/financeiro", label: "Financeiro" },
  { href: "/mais", label: "Mais" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const membership = await getActiveMembership(supabase);

  // Usuário logado mas sem empresa ainda (ex.: cadastro sem terminar o
  // onboarding, ou sessão de um convite pendente) -> volta pro onboarding.
  if (!membership) redirect("/onboarding");

  // Assinatura (0037). Cliente da SESSÃO, não o admin: a função usa auth.uid()
  // e is_company_member, que com a service role recusariam ("Não autenticado").
  // Falha fechada: erro ou sem assinatura -> /assinatura (que reconsulta e explica).
  const { data: accessData, error: accessError } = await supabase.rpc("get_company_access", {
    p_company_id: membership.companyId,
  });
  const access = parseAccess(accessData, accessError);
  if (!access.allowed) redirect("/assinatura");

  // Financeiro é sensível (RLS restringe a leitura a owner/admin) — não faz
  // sentido mostrar o item de navegação pra quem só vai ver telas vazias.
  const canSeeFinance = membership.role === "owner" || membership.role === "admin";
  const navItems = canSeeFinance ? NAV_ITEMS : NAV_ITEMS.filter((item) => item.href !== "/financeiro");

  return (
    <CompanyProvider membership={membership}>
      <div className="min-h-screen bg-cream md:flex">
        <AppNav items={navItems} companyName={membership.companyName} />

        <div className="flex-1 pb-20 md:pb-0">
          <MobileHeader companyName={membership.companyName} />
          {access.warning && (
            <div role="status" className="border-b border-ink-100 bg-sand px-4 py-2.5 text-center text-sm text-ink-700">
              {access.status === "ending" ? (
                membership.role === "owner" ? (
                  <>
                    Sua assinatura foi cancelada. O acesso continua até {formatUntil(access.until)}.{" "}
                    <a href={CHECKOUT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                      Assinar de novo
                    </a>
                  </>
                ) : (
                  `A assinatura deste negócio foi cancelada. O acesso continua até ${formatUntil(access.until)}.`
                )
              ) : membership.role === "owner" ? (
                <>
                  Há um problema com o pagamento da sua assinatura.{" "}
                  <a href={CHECKOUT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                    Ver no Mercado Pago
                  </a>
                </>
              ) : (
                "Há um problema com o pagamento da assinatura. Avise a dona da conta."
              )}
            </div>
          )}
          <main className="mx-auto max-w-3xl px-4 py-6 md:px-8">{children}</main>
        </div>
      </div>
    </CompanyProvider>
  );
}
