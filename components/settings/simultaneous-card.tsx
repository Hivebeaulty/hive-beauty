"use client";
// "Permitir mais de uma cliente no mesmo horário" (migration 0053). Pessoal: cada profissional
// escolhe para a própria agenda. Desligado por padrão. Se a migration ainda não foi aplicada, o card some.
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

export function SimultaneousCard() {
  const toast = useToast();
  const { memberId } = useCompany();
  const [available, setAvailable] = useState(true);
  const [value, setValue] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .rpc("get_my_allow_simultaneous", { p_member_id: memberId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setAvailable(false);
        else setValue(data === true);
      });
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  async function toggle() {
    if (value === null) return;
    const before = value;
    const next = !value;
    setValue(next);
    const { error } = await createClient().rpc("set_my_allow_simultaneous", { p_member_id: memberId, p_enabled: next });
    if (error) {
      setValue(before);
      toast.error("Não foi possível salvar. Tente novamente.");
    }
  }

  if (!available || value === null) return null;

  return (
    <Card className="space-y-2" data-testid="simultaneous-card">
      <div className="flex items-start gap-3">
        <Users className="mt-0.5 size-5 shrink-0 text-ink-700" aria-hidden="true" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-ink-800">Mais de uma cliente no mesmo horário</h2>
          <p className="mt-1 text-sm text-ink-500">
            Ligue se você atende duas clientes ao mesmo tempo. Quando o horário já estiver ocupado, o app pergunta antes de
            agendar junto. Desligado, cada horário recebe uma cliente só.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          aria-label="Permitir mais de uma cliente no mesmo horário"
          onClick={toggle}
          className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors", value ? "bg-ink-800" : "bg-ink-200")}
        >
          <span
            className={cn(
              "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
              value ? "left-[22px]" : "left-0.5"
            )}
          />
        </button>
      </div>
    </Card>
  );
}
