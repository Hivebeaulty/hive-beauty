"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";

type ServiceFormData = {
  id: string;
  name: string;
  categoryName: string;
  duration_minutes: number;
  price: number;
  active: boolean;
};

export function ServicoForm({ initial }: { initial?: ServiceFormData }) {
  const router = useRouter();
  const { companyId } = useCompany();
  const [name, setName] = useState(initial?.name ?? "");
  const [categoryName, setCategoryName] = useState(initial?.categoryName ?? "");
  const [duration, setDuration] = useState(initial?.duration_minutes ?? 60);
  const [price, setPrice] = useState(initial?.price ?? 0);
  const [active, setActive] = useState(initial?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolveCategoryId(supabase: ReturnType<typeof createClient>) {
    const trimmed = categoryName.trim();
    if (!trimmed) return null;

    const { data: existing } = await supabase
      .from("service_categories")
      .select("id")
      .eq("company_id", companyId)
      .ilike("name", trimmed)
      .maybeSingle();
    if (existing) return existing.id;

    const { data: created, error } = await supabase
      .from("service_categories")
      .insert({ company_id: companyId, name: trimmed })
      .select("id")
      .single();
    if (error) throw error;
    return created.id;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const supabase = createClient();

    try {
      const category_id = await resolveCategoryId(supabase);
      const payload = {
        company_id: companyId,
        category_id,
        name,
        duration_minutes: duration,
        price,
        active,
      };

      const { error } = initial
        ? await supabase.from("services").update(payload).eq("id", initial.id)
        : await supabase.from("services").insert(payload);

      if (error) throw error;
      router.push("/mais/servicos");
      router.refresh();
    } catch (err) {
      setError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Nome do serviço</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex: Alongamento em gel"
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Categoria (opcional)</label>
        <input
          value={categoryName}
          onChange={(e) => setCategoryName(e.target.value)}
          placeholder="Ex: Unhas"
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Duração (min)</label>
          <input
            type="number"
            required
            min={5}
            step={5}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Preço (R$)</label>
          <input
            type="number"
            required
            min={0}
            step={0.01}
            value={price}
            onChange={(e) => setPrice(Number(e.target.value))}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>
      </div>

      {initial && (
        <label className="flex items-center gap-2 text-sm text-charcoal-700">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Serviço ativo (some das opções de agendamento quando desativado)
        </label>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-60"
      >
        {saving ? "Salvando..." : "Salvar serviço"}
      </button>
    </form>
  );
}
