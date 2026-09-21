import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveMembership } from "@/lib/hive/membership";
import { CompanyProvider } from "@/components/company-provider";

const NAV_ITEMS = [
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
      <div className="min-h-screen bg-blush-100 md:flex">
        <aside className="hidden w-56 shrink-0 border-r border-blush-200 bg-white p-6 md:block">
          <h1 className="mb-1 text-xl font-bold text-plum-500">hive beauty</h1>
          <p className="mb-8 truncate text-xs text-charcoal-500">{membership.companyName}</p>
          <nav className="space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-xl px-4 py-2.5 text-sm font-medium text-charcoal-700 hover:bg-blush-50 hover:text-plum-500"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        <div className="flex-1 pb-20 md:pb-0">
          <main className="mx-auto max-w-3xl px-4 py-6 md:px-8">{children}</main>
        </div>

        <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-blush-200 bg-white md:hidden">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-medium text-charcoal-700"
            >
              <span className="h-6 w-6 rounded-full bg-blush-100" />
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </CompanyProvider>
  );
}
