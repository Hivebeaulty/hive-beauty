// Painel separado do app das profissionais. Mesmo padrão visual do app (superfície,
// ícone + logotipo da Sócia nas versões clara e escura) e um selo "Administração"
// para não confundir com a conta de uma profissional.
// Layouts não re-renderizam em toda navegação: por isso CADA página também chama
// requireSuperadmin(), e o banco confere de novo em cada função admin_*.
import Image from "next/image";
import Link from "next/link";
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";
import { AdminNav } from "@/components/admin/admin-nav";
import { LogoutButton } from "@/components/logout-button";
import { ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireSuperadmin();
  return (
    <div className="min-h-screen bg-cream">
      <header className="sticky top-0 z-20 border-b border-ink-100 bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 lg:px-6">
          <Link href="/admin" className="flex items-center gap-2.5" aria-label="Sócia, painel administrativo">
            <Image src="/logo-icon.png" alt="" width={28} height={28} priority className="dark:hidden" />
            <Image src="/logo-icon-dark.png" alt="" width={28} height={28} priority className="hidden dark:block" />
            <Image src="/logo-wordmark.png" alt="Sócia" width={78} height={24} priority className="mt-0.5 dark:hidden" />
            <Image src="/logo-wordmark-dark.png" alt="Sócia" width={78} height={24} priority className="mt-0.5 hidden dark:block" />
            <span className="ml-1 hidden items-center gap-1 rounded-full bg-wine-50 px-2.5 py-0.5 text-xs font-semibold text-wine-700 ring-1 ring-wine-100 sm:flex">
              <ShieldCheck className="size-3.5" aria-hidden />
              Administração
            </span>
          </Link>
          <Link href="/inicio" className="rounded px-2.5 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 hover:text-ink-800">
            Ir para o app
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-7xl gap-8 px-4 py-5 lg:grid lg:grid-cols-[220px_1fr] lg:px-6 lg:py-8">
        <aside className="mb-5 lg:mb-0">
          <div className="lg:sticky lg:top-24 lg:space-y-6">
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
