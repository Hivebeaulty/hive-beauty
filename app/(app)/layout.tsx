import { redirect } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { CompanyProvider } from "@/components/company-provider";
import { AppNav, type NavItem } from "@/components/app-nav";

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

  // Financeiro é sensível (RLS restringe a leitura a owner/admin) — não faz
  // sentido mostrar o item de navegação pra quem só vai ver telas vazias.
  const canSeeFinance = membership.role === "owner" || membership.role === "admin";
  const navItems = canSeeFinance ? NAV_ITEMS : NAV_ITEMS.filter((item) => item.href !== "/financeiro");

  return (
    <CompanyProvider membership={membership}>
      <div className="min-h-screen bg-cream md:flex">
        <AppNav items={navItems} companyName={membership.companyName} />

        <div className="flex-1 pb-20 md:pb-0">
          {/* Presença discreta da marca no mobile — no desktop a sidebar já
              cumpre esse papel, então isso não aparece lá (md:hidden). */}
          <header className="flex items-center gap-1.5 border-b border-ink-100 px-4 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top,0px))] md:hidden">
            <Image src="/logo-icon.png" alt="" width={16} height={16} />
            <Image src="/logo-wordmark.png" alt="Áurea" width={48} height={11} />
          </header>
          <main className="mx-auto max-w-3xl px-4 py-6 md:px-8">{children}</main>
        </div>
      </div>
    </CompanyProvider>
  );
}
