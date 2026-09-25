"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatDuration, formatMoney } from "@/lib/hive/format";

type ServiceFormData = {
  id: string;
  name: string;
  categoryName: string;
  duration_minutes: number;
  price: number;
  active: boolean;
};

// Mesma lógica de sempre: categoria é texto livre que busca-ou-cria em
// service_categories (case-insensitive). A <datalist> só ajuda a reaproveitar
// o nome de uma categoria já existente sem digitar de novo — não é um
// sistema novo, é o mesmo "resolveCategoryId" de antes com uma sugestão.
export function ServicoForm({ initial }: { initial?: ServiceFormData }) {
  const router = useRouter();
  const { companyId } = useCompany();
  const [name, setName] = useState(initial?.name ?? "");
  const [categoryName, setCategoryName] = useState(initial?.categoryName ?? "");
  const [existingCategories, setExistingCategories] = useState<string[]>([]);
  const [duration, setDuration] = useState(initial?.duration_minutes ?? 60);
  const [price, setPrice] = useState(initial?.price ?? 0);
  const [active, setActive] = useState(initial?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .from("service_categories")
      .select("name")
      .eq("company_id", companyId)
      .then(({ data }) => setExistingCategories((data ?? []).map((c) => c.name)));
  }, [companyId]);

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

      // Importante: isso NUNCA toca em appointments já criados. price e
      // duração (via scheduled_start/end) ficam gravados no próprio
      // atendimento na hora da criação — editar o serviço aqui não altera
      // histórico, só passa a valer para os próximos agendamentos.
      const { error } = initial
        ? await supabase.from("services").update(payload).eq("id", initial.id)
        : await supabase.from("services").insert(payload);

      if (error) throw error;
      router.push("/mais/servicos");
      router.refresh();
    } catch {
      setError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Nome do serviço"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ex: Alongamento em gel"
      />

      <div>
        <Input
          label="Categoria (opcional)"
          list="categorias-existentes"
          value={categoryName}
          onChange={(e) => setCategoryName(e.target.value)}
          placeholder="Ex: Unhas"
        />
        <datalist id="categorias-existentes">
          {existingCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input
          type="number"
          label="Duração (min)"
          required
          min={5}
          step={5}
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          hint={formatDuration(duration)}
        />
        <Input
          type="number"
          label="Preço (R$)"
          required
          min={0}
          step={0.01}
          value={price}
          onChange={(e) => setPrice(Number(e.target.value))}
        />
      </div>

      {/* Prévia — "informação operacional", não só campos soltos */}
      {name && (
        <div className="rounded-lg border border-ink-100 bg-ink-50/50 px-4 py-3 text-sm">
          <p className="font-semibold text-ink-800">{name}</p>
          <p className="text-ink-500">
            {formatMoney(price)} · {formatDuration(duration)}
          </p>
        </div>
      )}

      <div className="flex items-center gap-3 rounded-lg border border-ink-100 p-4">
        <Switch checked={active} onChange={setActive} label="Serviço ativo" />
        <div>
          <p className="text-sm font-medium text-ink-800">Serviço ativo</p>
          <p className="text-xs text-ink-400">Desativado, some das opções de novo atendimento — o histórico continua intacto.</p>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Button type="submit" loading={saving} className="w-full">
        {saving ? "Salvando..." : "Salvar serviço"}
      </Button>
    </form>
  );
}
