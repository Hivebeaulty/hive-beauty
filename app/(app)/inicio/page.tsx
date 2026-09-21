import { createClient } from "@/lib/supabase/server";

export default async function InicioPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-charcoal-700">Bem-vinda de volta,</p>
        <h1 className="text-2xl font-bold text-charcoal-900">
          {user?.user_metadata?.full_name ?? "Profissional"}
        </h1>
      </div>

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-plum-500">Hoje</h2>
        <div className="grid grid-cols-2 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold text-charcoal-900">—</p>
            <p className="text-xs text-charcoal-700">Atendimentos</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-charcoal-900">R$ —</p>
            <p className="text-xs text-charcoal-700">Faturamento previsto</p>
          </div>
        </div>
      </section>

      <p className="text-center text-xs text-charcoal-500">
        Os indicadores completos, alertas e a agenda do dia entram na Fase 2.
      </p>
    </div>
  );
}
