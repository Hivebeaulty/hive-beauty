"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";

const WEEKDAY_LABEL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

type DayConfig = { open: boolean; start: string; end: string };

// Sugestão só pra não deixar a operadora preenchendo 7 linhas do zero — nada
// é gravado até ela conferir e apertar "Salvar horários".
const SUGGESTED_DAYS: DayConfig[] = [
  { open: false, start: "09:00", end: "19:00" }, // domingo
  { open: true, start: "09:00", end: "19:00" },
  { open: true, start: "09:00", end: "19:00" },
  { open: true, start: "09:00", end: "19:00" },
  { open: true, start: "09:00", end: "19:00" },
  { open: true, start: "09:00", end: "19:00" },
  { open: true, start: "09:00", end: "18:00" }, // sábado
];

export function BusinessHoursCard({ companyId }: { companyId: string }) {
  const toast = useToast();
  const [days, setDays] = useState<DayConfig[]>(SUGGESTED_DAYS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hadExisting, setHadExisting] = useState(false);

  useEffect(() => {
    createClient()
      .from("business_hours")
      .select("weekday, start_time, end_time")
      .eq("company_id", companyId)
      .is("professional_member_id", null)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setHadExisting(true);
          setDays(
            SUGGESTED_DAYS.map((fallback, weekday) => {
              const row = data.find((r) => r.weekday === weekday);
              return row
                ? { open: true, start: row.start_time.slice(0, 5), end: row.end_time.slice(0, 5) }
                : { ...fallback, open: false };
            })
          );
        }
        setLoading(false);
      });
  }, [companyId]);

  function updateDay(i: number, patch: Partial<DayConfig>) {
    setDays((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  async function handleSave() {
    const invalid = days.some((d) => d.open && d.start >= d.end);
    if (invalid) {
      toast.error("Tem um dia com horário de término antes do início. Confira antes de salvar.");
      return;
    }

    setSaving(true);
    const supabase = createClient();
    // Sem constraint única em (company_id, weekday) pra dar upsert — apaga o
    // horário padrão da empresa (professional_member_id nulo) e recria do
    // zero a partir do formulário. Não mexe em horário específico de
    // profissional (isso é outra coisa, não existe UI pra isso ainda).
    await supabase.from("business_hours").delete().eq("company_id", companyId).is("professional_member_id", null);

    const rows = days
      .map((d, weekday) => ({ ...d, weekday }))
      .filter((d) => d.open)
      .map((d) => ({
        company_id: companyId,
        professional_member_id: null,
        weekday: d.weekday,
        start_time: d.start,
        end_time: d.end,
      }));

    const { error } = rows.length > 0 ? await supabase.from("business_hours").insert(rows) : { error: null };
    setSaving(false);
    if (error) toast.error("Não foi possível salvar o horário de funcionamento.");
    else {
      setHadExisting(true);
      toast.success("Horário de funcionamento atualizado.");
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-ink-100 bg-surface p-5">
      <div>
        <h2 className="text-sm font-semibold text-ink-700">Horário de funcionamento</h2>
        <p className="text-xs text-ink-400">Define os horários que aparecem como disponíveis ao criar um atendimento.</p>
      </div>

      {!loading && !hadExisting && (
        <p className="rounded-md bg-gold-50 px-3 py-2 text-xs text-gold-700">
          Nenhum horário cadastrado ainda — deixamos uma sugestão abaixo. Revise e salve.
        </p>
      )}

      <div className="space-y-2.5">
        {WEEKDAY_LABEL.map((label, i) => {
          const d = days[i];
          return (
            <div key={label} className="flex items-center gap-3">
              <Switch checked={d.open} onChange={(v) => updateDay(i, { open: v })} label={label} disabled={loading} />
              <span className="w-16 shrink-0 text-sm text-ink-700">{label.slice(0, 3)}</span>
              {d.open ? (
                <div className="flex flex-1 items-center gap-1.5">
                  <input
                    type="time"
                    value={d.start}
                    onChange={(e) => updateDay(i, { start: e.target.value })}
                    className="w-full rounded border border-ink-200 bg-surface px-2 py-1.5 text-sm text-ink-800 outline-none focus:border-ink-800"
                  />
                  <span className="text-ink-300">–</span>
                  <input
                    type="time"
                    value={d.end}
                    onChange={(e) => updateDay(i, { end: e.target.value })}
                    className="w-full rounded border border-ink-200 bg-surface px-2 py-1.5 text-sm text-ink-800 outline-none focus:border-ink-800"
                  />
                </div>
              ) : (
                <span className="flex-1 text-sm text-ink-300">Fechado</span>
              )}
            </div>
          );
        })}
      </div>

      <Button size="sm" loading={saving} disabled={loading} onClick={handleSave}>
        {saving ? "Salvando..." : "Salvar horários"}
      </Button>
    </div>
  );
}
