"use client";

// Mensagem de confirmação: opção 1 (mensagens variadas do sistema) ou opção 2
// (mensagem própria com variáveis). Ler: qualquer membro; mudar: owner/admin —
// garantido pelas RPCs da 0027. Ausente/erro: o cartão não aparece.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { buildConfirmationMessage } from "@/lib/hive/appointment-message";
import {
  CONFIRMATION_VARIABLES,
  CONFIRMATION_TEMPLATE_MAX,
  DEFAULT_CUSTOM_TEMPLATE,
  confirmationTemplateProblems,
} from "@/lib/hive/message-template";
import { cn } from "@/lib/utils";

type Mode = "system" | "custom";

// Exemplo fixo para a prévia (sexta-feira, 14h30).
const SAMPLE = {
  clientName: "Ana Lima",
  serviceName: "Manicure",
  startsAt: new Date("2026-10-16T17:30:00Z"),
  durationMinutes: 60,
  now: new Date("2026-10-10T12:00:00Z"),
};

export function WhatsappConfirmationTemplate({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [loaded, setLoaded] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [mode, setMode] = useState<Mode>("system");
  const [savedMode, setSavedMode] = useState<Mode>("system");
  const [template, setTemplate] = useState(DEFAULT_CUSTOM_TEMPLATE);
  const [savedTemplate, setSavedTemplate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    createClient()
      .rpc("wa_get_message_settings", { p_company_id: companyId })
      .then(({ data, error: e }) => {
        if (!alive || e || !data) return;
        const d = data as { mode?: string; template?: string | null; can_manage?: boolean };
        const m: Mode = d.mode === "custom" ? "custom" : "system";
        setMode(m);
        setSavedMode(m);
        if (d.template) setTemplate(d.template);
        setSavedTemplate(d.template ?? null);
        setCanManage(d.can_manage === true);
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [companyId]);

  if (!loaded) return null;

  const problems = mode === "custom" ? confirmationTemplateProblems(template) : [];
  const dirty = mode !== savedMode || (mode === "custom" && template !== (savedTemplate ?? DEFAULT_CUSTOM_TEMPLATE));
  const preview = buildConfirmationMessage({
    ...SAMPLE,
    businessName: companyName,
    variantSeed: "previa",
    customTemplate: mode === "custom" ? template : null,
  });

  function insert(key: string) {
    const token = `{${key}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    if (saving || problems.length > 0) return;
    setSaving(true);
    setError(null);
    setSavedAt(false);
    const { error: e } = await createClient().rpc("wa_set_message_settings", {
      p_company_id: companyId,
      p_mode: mode,
      p_template: mode === "custom" ? template : null,
    });
    setSaving(false);
    if (e) {
      setError(e.code === "AUT01" ? e.message : e.code === "42501" ? "Só a administração da empresa pode mudar isso." : "Não foi possível salvar. Tente de novo.");
      return;
    }
    setSavedMode(mode);
    if (mode === "custom") setSavedTemplate(template);
    setSavedAt(true);
  }

  const option = (value: Mode, title: string, description: string) => (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
        mode === value ? "border-gold-500 bg-sand" : "border-ink-100 hover:bg-sand/50",
        !canManage && "cursor-default"
      )}
    >
      <input
        type="radio"
        name="confirmation-mode"
        className="mt-1 size-4 shrink-0 accent-ink-800"
        checked={mode === value}
        disabled={!canManage}
        onChange={() => { setMode(value); setSavedAt(false); }}
      />
      <span>
        <span className="block text-sm font-semibold text-ink-800">{title}</span>
        <span className="block text-xs text-ink-500">{description}</span>
      </span>
    </label>
  );

  return (
    <Card className="space-y-4" data-testid="wa-confirmation-template">
      <div>
        <h2 className="text-sm font-semibold text-ink-800">Mensagem de confirmação</h2>
        <p className="mt-1 text-sm text-ink-500">Enviada quando um agendamento é criado (e no envio manual pelo celular).</p>
      </div>

      <div className="space-y-2" role="radiogroup" aria-label="Formato da mensagem de confirmação">
        {option("system", "Mensagens do sistema", "Textos variados e acolhedores, para não repetir sempre a mesma frase.")}
        {option("custom", "Minha mensagem", "Um texto seu, igual para todas, com o nome da cliente, a data e o horário.")}
      </div>

      {mode === "custom" && (
        <div className="space-y-2">
          <Textarea
            ref={ref}
            label="Sua mensagem"
            rows={6}
            value={template}
            disabled={!canManage}
            maxLength={CONFIRMATION_TEMPLATE_MAX + 200}
            onChange={(e) => { setTemplate(e.target.value); setSavedAt(false); }}
          />
          {canManage && (
            <div className="flex flex-wrap gap-1.5">
              {CONFIRMATION_VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insert(v.key)}
                  className="rounded-full border border-ink-200 bg-surface px-2.5 py-1 text-xs font-medium text-ink-600 hover:border-gold-500 hover:text-ink-800"
                  title={`${v.label} — ex.: ${v.example}`}
                >
                  {`{${v.key}}`}
                </button>
              ))}
            </div>
          )}
          {problems.length > 0 && (
            <ul className="space-y-0.5 text-xs text-danger" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-500">
          Prévia{mode === "system" ? " (um dos textos variados)" : ""}
        </p>
        <div className="rounded-lg bg-sand p-3">
          <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-lg rounded-tl-sm border border-ink-100 bg-surface px-3.5 py-2.5 text-sm text-ink-800">
            {preview}
          </div>
        </div>
      </div>

      {canManage ? (
        <div className="flex items-center gap-3">
          <Button onClick={save} loading={saving} disabled={!dirty || problems.length > 0}>
            Salvar
          </Button>
          {savedAt && !dirty && <span className="text-xs text-success" role="status">Salvo.</span>}
          {error && <span className="text-xs text-danger" role="alert">{error}</span>}
        </div>
      ) : (
        <p className="text-xs text-ink-400">Só a administração da empresa pode mudar.</p>
      )}
    </Card>
  );
}
