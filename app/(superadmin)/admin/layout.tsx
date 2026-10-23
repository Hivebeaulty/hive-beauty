// Painel separado do app das profissionais. O topo escuro marca de propósito que
// aqui se vê a plataforma inteira; o resto usa os componentes da Áurea.
// Layouts não re-renderizam em toda navegação: por isso CADA página também chama
// requireSuperadmin(), e o banco confere de novo em cada função admin_*.
import Link from "next/link";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { AdminNav } from "@/components/admin/admin-nav";
import { LogoutButton } from "@/components/logout-button";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireSuperadmin();
  return (
    <div className="min-h-screen bg-cream">
      <header className="bg-ink-900 text-cream">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 lg:px-6">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-lg">Áurea</span>
            <span className="text-sm text-cream/60">Administração da plataforma</span>
          </div>
          <Link href="/inicio" className="text-sm text-cream/70 hover:text-cream">
            Ir para o app
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-7xl gap-8 px-4 py-5 lg:grid lg:grid-cols-[200px_1fr] lg:px-6 lg:py-8">
        <aside className="mb-5 lg:mb-0">
          <div className="lg:sticky lg:top-8 lg:space-y-6">
            <AdminNav />
            <div className="hidden lg:block">
              <LogoutButton variant="sidebar" />
            </div>
          </div>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
