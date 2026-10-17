"use client";

// Mensagem de ANIVERSÁRIO (0031): liga/desliga + sistema (variadas) ou mensagem
// própria. Ler: qualquer membro; mudar: owner/admin (garantido pelas RPCs).
// Ausente/erro: o cartão não aparece.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  BIRTHDAY_TEMPLATE_MAX,
  BIRTHDAY_VARIABLES,
  DEFAULT_BIRTHDAY_TEMPLATE,
  birthdayTemplateProblems,
  buildBirthdayMessage,
} from "@/lib/hive/birthday-message";
import { cn } from "@/lib/utils";

type Mode = "system" | "custom";
type Saved = { enabled: boolean; mode: Mode; template: string | null };

export function WhatsappBirthdayMessage({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [loaded, setLoaded] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<Mode>("system");
  const [template, setTemplate] = useState(DEFAULT_BIRTHDAY_TEMPLATE);
  const [saved, setSaved] = useState<Saved>({ enabled: false, mode: "system", template: null });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    createClient()
      .rpc("wa_get_birthday_settings", { p_company_id: companyId })
      .then(({ data, error: e }) => {
        if (!alive || e || !data) return;
        const d = data as { enabled?: boolean; mode?: string; template?: string | null; can_manage?: boolean };
        const m: Mode = d.mode === "custom" ? "custom" : "system";
        setEnabled(d.enabled === true);
        setMode(m);
        if (d.template) setTemplate(d.template);
        setSaved({ enabled: d.enabled === true, mode: m, template: d.template ?? null });
        setCanManage(d.can_manage === true);
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [companyId]);

  if (!loaded) return null;

  const problems = mode === "custom" ? birthdayTemplateProblems(template) : [];
  const dirty =
    enabled !== saved.enabled || mode !== saved.mode || (mode === "custom" && template !== (saved.template ?? DEFAULT_BIRTHDAY_TEMPLATE));
  const preview = buildBirthdayMessage({
    mode,
    template,
    clientName: "Ana Lima",
    businessName: companyName,
    clientId: "previa",
    year: new Date().getFullYear(),
  });

  function insert(key: string) {
    const token = `{${key}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
    setSavedOk(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    if (saving || problems.length > 0) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    const { error: e } = await createClient().rpc("wa_set_birthday_settings", {
      p_company_id: companyId,
      p_enabled: enabled,
      p_mode: mode,
      p_template: mode === "custom" ? template : null,
    });
    setSaving(false);
    if (e) {
      setError(e.code === "AUT01" ? e.message : e.code === "42501" ? "Só a administração da empresa pode mudar isso." : "Não foi possível salvar. Tente de novo.");
      return;
    }
    setSaved({ enabled, mode, template: mode === "custom" ? template : saved.template });
    setSavedOk(true);
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
        name="birthday-mode"
        className="mt-1 size-4 shrink-0 accent-ink-800"
        checked={mode === value}
        disabled={!canManage}
        onChange={() => { setMode(value); setSavedOk(false); }}
      />
      <span>
        <span className="block text-sm font-semibold text-ink-800">{title}</span>
        <span className="block text-xs text-ink-500">{description}</span>
      </span>
    </label>
  );

  return (
    <Card className="space-y-4" data-testid="wa-birthday">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-800">Mensagem de aniversário</h2>
          <p className="mt-1 text-sm text-ink-500">
            Enviada às 9h do dia do aniversário, só para clientes que autorizaram receber mensagens.
          </p>
        </div>
        <div className="pt-0.5">
          <Switch
            checked={enabled}
            disabled={!canManage}
            onChange={(v) => { setEnabled(v); setSavedOk(false); }}
            label="Enviar mensagem de aniversário"
          />
        </div>
      </div>

      <div className="space-y-2" role="radiogroup" aria-label="Formato da mensagem de aniversário">
        {option("system", "Mensagens do sistema", "Textos variados e carinhosos, que mudam de um ano para o outro.")}
        {option("custom", "Minha mensagem", "Um texto seu, com o nome da cliente.")}
      </div>

      {mode === "custom" && (
        <div className="space-y-2">
          <Textarea
            ref={ref}
            label="Sua mensagem"
            rows={4}
            value={template}
            disabled={!canManage}
            maxLength={BIRTHDAY_TEMPLATE_MAX + 200}
            onChange={(e) => { setTemplate(e.target.value); setSavedOk(false); }}
          />
          {canManage && (
            <div className="flex flex-wrap gap-1.5">
              {BIRTHDAY_VARIABLES.map((v) => (
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
        <p className="mb-1.5 text-xs font-medium text-ink-500">Prévia{mode === "system" ? " (um dos textos variados)" : ""}</p>
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
          {savedOk && !dirty && (
            <span className="text-xs text-success" role="status">
              {enabled ? "Salvo. As mensagens de aniversário estão ligadas." : "Salvo. As mensagens de aniversário estão desligadas."}
            </span>
          )}
          {error && <span className="text-xs text-danger" role="alert">{error}</span>}
        </div>
      ) : (
        <p className="text-xs text-ink-400">Só a administração da empresa pode mudar.</p>
      )}
    </Card>
  );
}
