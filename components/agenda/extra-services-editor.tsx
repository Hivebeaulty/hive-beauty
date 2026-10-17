"use client";

// Serviços ADICIONAIS do atendimento (0033). Usado em novo atendimento e na
// edição. Valor e duração vêm do cadastro do serviço e podem ser ajustados.
import { Plus, X } from "lucide-react";
import { Select } from "@/components/ui/select";
import { NumberInput } from "@/components/ui/number-input";
import { formatDuration, formatMoney } from "@/lib/hive/format";
import { MAX_EXTRA_SERVICES, type ExtraItem } from "@/lib/hive/extra-services";

export type ServiceChoice = { id: string; name: string; duration_minutes: number; price: number; active?: boolean };

export function ExtraServicesEditor({
  services,
  value,
  onChange,
  disabled,
  total,
}: {
  services: ServiceChoice[];
  value: ExtraItem[];
  onChange: (next: ExtraItem[]) => void;
  disabled?: boolean;
  /** Resumo do atendimento inteiro (principal + adicionais). */
  total?: { price: number; minutes: number };
}) {
  const update = (i: number, patch: Partial<ExtraItem>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const choose = (i: number, id: string) => {
    const s = services.find((x) => x.id === id);
    update(i, { service_id: id, price: s ? Number(s.price) : 0, duration_minutes: s ? s.duration_minutes : 30 });
  };

  return (
    <div className="space-y-3" data-testid="extra-services">
      {value.map((e, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-ink-100 bg-sand/50 p-3">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Select label={`Serviço adicional ${i + 1}`} required value={e.service_id} disabled={disabled} onChange={(ev) => choose(i, ev.target.value)}>
                <option value="" disabled>
                  Escolha o serviço
                </option>
                {services
                  .filter((s) => s.active !== false || s.id === e.service_id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {formatDuration(s.duration_minutes)}
                    </option>
                  ))}
              </Select>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="mb-1 flex size-10 shrink-0 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-500 hover:text-danger disabled:opacity-50"
              aria-label={`Remover serviço adicional ${i + 1}`}
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberInput label="Valor (R$)" required value={e.price} onChange={(v) => update(i, { price: v })} />
            <NumberInput integer label="Duração (min)" required value={e.duration_minutes} onChange={(v) => update(i, { duration_minutes: v })} />
          </div>
        </div>
      ))}

      {value.length < MAX_EXTRA_SERVICES && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...value, { service_id: "", price: 0, duration_minutes: 30 }])}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-200 px-3 py-2.5 text-sm font-medium text-ink-600 hover:border-gold-500 hover:text-ink-800 disabled:opacity-50"
        >
          <Plus className="size-4" />
          Adicionar outro serviço
        </button>
      )}

      {total && value.length > 0 && (
        <p className="text-sm text-ink-600" data-testid="extra-total">
          Total do atendimento: <strong className="font-semibold text-ink-800">{formatMoney(total.price)}</strong> ·{" "}
          {formatDuration(total.minutes)}
        </p>
      )}
    </div>
  );
}
