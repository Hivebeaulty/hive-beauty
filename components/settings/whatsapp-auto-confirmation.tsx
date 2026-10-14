"use client";

// Confirmação automática (W5) — preferência da empresa. Só aparece quando a
// operação já ligou o recurso neste ambiente (available) E a empresa já pediu
// conexão do WhatsApp (configured). Ler: qualquer membro; mudar: owner/admin —
// garantido pelas RPCs da 0018 (wa_get_auto_confirmation / wa_set_auto_confirmation).
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

type Pref = { enabled: boolean; canManage: boolean };

export function WhatsappAutoConfirmation({ companyId }: { companyId: string }) {
  const [pref, setPref] = useState<Pref | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    createClient()
      .rpc("wa_get_auto_confirmation", { p_company_id: companyId })
      .then(({ data, error: e }) => {
        if (!alive || e || !data || typeof data !== "object") return; // 0018 ausente ou erro: oculto
        const d = data as Record<string, unknown>;
        if (d.available !== true || d.configured !== true) return;
        setPref({ enabled: d.enabled === true, canManage: d.can_manage === true });
      });
    return () => {
      alive = false;
    };
  }, [companyId]);

  if (!pref) return null;

  async function change(next: boolean) {
    if (saving || !pref) return;
    setSaving(true);
    setError(null);
    const { error: e } = await createClient().rpc("wa_set_auto_confirmation", { p_company_id: companyId, p_enabled: next });
    setSaving(false);
    if (e) {
      setError(e.code === "42501" ? "Só a administração da empresa pode mudar isso." : "Não foi possível salvar. Tente de novo.");
      return;
    }
    setPref({ ...pref, enabled: next });
  }

  return (
    <Card className="space-y-2" data-testid="wa-auto-confirmation">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink-800">Confirmação automática de agendamento</p>
          <p className="mt-1 text-sm text-ink-500">
            {pref.enabled
              ? "Cada novo agendamento envia uma confirmação pelo WhatsApp da empresa, se a cliente tiver celular válido e não tiver pedido para sair."
              : "Desligada: as confirmações continuam disponíveis para envio manual pelo celular."}
          </p>
        </div>
        <Switch
          checked={pref.enabled}
          onChange={change}
          disabled={!pref.canManage || saving}
          label="Confirmação automática de agendamento"
        />
      </div>
      {!pref.canManage && <p className="text-xs text-ink-400">Só a administração da empresa pode mudar.</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </Card>
  );
}
