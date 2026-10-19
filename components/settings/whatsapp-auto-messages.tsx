"use client";

// Mensagens automáticas por data (0035): liga/desliga cada uma + sistema ou própria.
// Ler: qualquer membro; mudar: owner/admin (garantido pelas RPCs). Erro/ausente: não aparece.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { AUTO_MESSAGES, AUTO_SYSTEM_TEMPLATES, autoTemplateProblems, buildAutoMessage, type AutoKind } from "@/lib/hive/auto-messages";
import { cn } from "@/lib/utils";

type Item = { enabled: boolean; mode: "system" | "custom"; template: string | null };

export function WhatsappAutoMessages({ companyId, companyName }: { companyId: string; companyName: string }) {
  const toast = useToast();
  const [items, setItems] = useState<Record<string, Item> | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [open, setOpen] = useState<AutoKind | null>(null);
  const [draft, setDraft] = useState<{ mode: "system" | "custom"; template: string }>({ mode: "system", template: "" });
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    createClient().rpc("wa_get_auto_messages", { p_company_id: companyId }).then(({ data, error }) => {
      if (!alive || error || !data) return;
      const d = data as { can_manage?: boolean; items?: Record<string, Item> };
      setItems(d.items ?? {});
      setCanManage(d.can_manage === true);
    });
    return () => { alive = false; };
  }, [companyId]);

  if (!items) return null;

  async function save(kind: AutoKind, next: Item, okMessage: string) {
    setSaving(kind);
    const { data, error } = await createClient().rpc("wa_set_auto_message", {
      p_company_id: companyId, p_kind: kind, p_enabled: next.enabled, p_mode: next.mode, p_template: next.mode === "custom" ? next.template : null,
    });
    setSaving(null);
    if (error) {
      toast.error(error.code === "AUT01" ? error.message : error.code === "42501" ? "Só a administração da empresa pode mudar isso." : "Não foi possível salvar. Tente de novo.");
      return false;
    }
    setItems(((data as { items?: Record<string, Item> }) ?? {}).items ?? items);
    toast.success(okMessage);
    return true;
  }

  const year = new Date().getFullYear();
  return (
    <Card className="space-y-3" data-testid="wa-auto">
      <div>
        <h2 className="text-sm font-semibold text-ink-800">Mensagens automáticas por data</h2>
        <p className="mt-1 text-sm text-ink-500">Enviadas às 9h do dia, com o nome de cada cliente, só para quem autorizou receber mensagens.</p>
      </div>
      <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100">
        {AUTO_MESSAGES.map((m) => {
          const it = items[m.kind] ?? { enabled: false, mode: "system", template: null };
          const isOpen = open === m.kind;
          const problems = isOpen && draft.mode === "custom" ? autoTemplateProblems(m.kind, draft.template) : [];
          const preview = buildAutoMessage({
            kind: m.kind, mode: isOpen ? draft.mode : it.mode, template: isOpen ? draft.template : it.template,
            clientId: "previa", year, name: "Ana Lima", business: companyName, years: 2,
          });
          return (
            <li key={m.kind} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-800">{m.title}</p>
                  <p className="text-xs text-ink-500">
                    {m.when} · {it.mode === "custom" ? "Minha mensagem" : "Mensagens do sistema"}
                  </p>
                  {canManage && (
                    <button
                      type="button"
                      className="mt-1 text-xs font-semibold text-gold-700 hover:underline"
                      onClick={() => {
                        setOpen(isOpen ? null : m.kind);
                        setDraft({ mode: it.mode, template: it.template ?? AUTO_SYSTEM_TEMPLATES[m.kind][0] });
                      }}
                    >
                      {isOpen ? "Fechar" : "Personalizar"}
                    </button>
                  )}
                </div>
                <div className="shrink-0 pt-0.5">
                  <Switch
                    checked={it.enabled}
                    disabled={!canManage || saving === m.kind}
                    onChange={(v) => save(m.kind, { ...it, enabled: v }, v ? `${m.title}: mensagem ligada.` : `${m.title}: mensagem desligada.`)}
                    label={`Enviar mensagem de ${m.title}`}
                  />
                </div>
              </div>
              {isOpen && (
                <div className="mt-3 space-y-2.5 animate-rise">
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={`Formato da mensagem de ${m.title}`}>
                    {(["system", "custom"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={draft.mode === mode}
                        onClick={() => setDraft({ ...draft, mode })}
                        className={cn("rounded-lg border px-3 py-2 text-left text-sm font-semibold text-ink-800 transition-colors",
                          draft.mode === mode ? "border-gold-500 bg-sand" : "border-ink-100 hover:bg-sand/60")}
                      >
                        {mode === "system" ? "Do sistema" : "Minha mensagem"}
                      </button>
                    ))}
                  </div>
                  {draft.mode === "custom" && (
                    <>
                      <Textarea label="Sua mensagem" rows={3} value={draft.template} onChange={(e) => setDraft({ ...draft, template: e.target.value })} />
                      <div className="flex flex-wrap gap-1.5">
                        {m.vars.map((v) => (
                          <button key={v} type="button" onClick={() => setDraft({ ...draft, template: `${draft.template}{${v}}` })}
                            className="rounded-full border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-600 hover:border-gold-500">{`{${v}}`}</button>
                        ))}
                      </div>
                      {problems.length > 0 && <p className="text-xs text-danger" role="alert">{problems.join(" ")}</p>}
                    </>
                  )}
                  <div className="rounded-lg bg-sand p-2.5">
                    <p className="mb-1 text-[11px] font-medium text-ink-500">Prévia{draft.mode === "system" ? " (um dos textos do sistema)" : ""}</p>
                    <p className="whitespace-pre-wrap break-words rounded-md border border-ink-100 bg-surface px-3 py-2 text-sm text-ink-800">{preview}</p>
                  </div>
                  <Button size="sm" loading={saving === m.kind} disabled={problems.length > 0}
                    onClick={async () => { if (await save(m.kind, { ...it, mode: draft.mode, template: draft.template }, `${m.title}: mensagem salva.`)) setOpen(null); }}>
                    Salvar
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
