// Painel separado do app principal — visualmente distinto de propósito
// (fundo escuro/neutro) para nunca ser confundido com a experiência da cliente.
import { requireSuperadmin } from "@/lib/supabase/require-superadmin";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Layouts não re-renderizam em toda navegação cliente; por isso a página também
  // chama requireSuperadmin() antes de qualquer consulta com service role.
  await requireSuperadmin();
  return (
    <div className="min-h-screen bg-ink-900 text-cream">
      <header className="border-b border-white/10 px-6 py-4">
        <p className="text-sm uppercase tracking-widest text-white/50">Áurea</p>
        <h1 className="text-lg font-bold">SuperAdmin</h1>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
