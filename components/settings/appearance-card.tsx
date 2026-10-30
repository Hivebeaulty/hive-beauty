"use client";
// Aparência: Claro, Escuro ou Automático. Vale para este aparelho.
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { THEME_OPTIONS, readThemePref, saveThemePref, type ThemePref } from "@/lib/hive/theme";
import { cn } from "@/lib/utils";

export function AppearanceCard() {
  const [pref, setPref] = useState<ThemePref>("light");
  useEffect(() => setPref(readThemePref()), []);
  return (
    <Card className="space-y-3" data-testid="appearance">
      <div>
        <h2 className="text-sm font-semibold text-ink-800">Aparência</h2>
        <p className="mt-1 text-sm text-ink-500">Escolha o tema da Sócia neste aparelho.</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tema">
        {THEME_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={pref === o.value}
            onClick={() => { setPref(o.value); saveThemePref(o.value); }}
            className={cn(
              "flex min-w-0 items-baseline justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors sm:block",
              pref === o.value ? "border-gold-500 bg-sand" : "border-ink-100 hover:bg-sand/60"
            )}
          >
            <span className="block shrink-0 text-sm font-semibold text-ink-800">{o.label}</span>
            <span className="block text-right text-xs leading-tight text-ink-500 sm:text-left">{o.hint}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
