"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";

type ExpenseFormData = {
  id: string;
  description: string;
  categoryName: string;
  amount: number;
  payment_method: string;
  status: "pago" | "pendente" | "parcial";
  due_date: string;
  notes: string;
};

const DEFAULT_CATEGORIES = ["Materiais", "Produtos", "Aluguel", "Equipamentos", "Comissão", "Marketing", "Outros"];

export function DespesaForm({ initial }: { initial?: ExpenseFormData }) {
  const router = useRouter();
  const { companyId } = useCompany();
  const [description, setDescription] = useState(initial?.description ?? "");
  const [categoryName, setCategoryName] = useState(initial?.categoryName ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? 0);
  const [method, setMethod] = useState(initial?.payment_method ?? "pix");
  const [status, setStatus] = useState<ExpenseFormData["status"]>(initial?.status ?? "pago");
  const [dueDate, setDueDate] = useState(initial?.due_date ?? new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolveCategoryId(supabase: ReturnType<typeof createClient>) {
    const trimmed = categoryName.trim();
    if (!trimmed) return null;
    const { data: existing } = await supabase
      .from("expense_categories")
      .select("id")
      .eq("company_id", companyId)
      .ilike("name", trimmed)
      .maybeSingle();
    if (existing) return existing.id;
    const { data: created, error } = await supabase
      .from("expense_categories")
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
        description,
        amount,
        payment_method: method,
        status,
        due_date: dueDate || null,
        paid_at: status === "pago" ? new Date().toISOString() : null,
      };

      const { error } = initial
        ? await supabase.from("expenses").update(payload).eq("id", initial.id)
        : await supabase.from("expenses").insert(payload);

      if (error) throw error;
      router.push("/financeiro/despesas");
      router.refresh();
    } catch {
      setError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!initial) return;
    if (!confirm("Excluir esta despesa? Essa ação não pode ser desfeita.")) return;
    setDeleting(true);
    const supabase = createClient();
    const { error } = await supabase.from("expenses").delete().eq("id", initial.id);
    setDeleting(false);
    if (error) {
      setError("Não foi possível excluir.");
      return;
    }
    router.push("/financeiro/despesas");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Descrição</label>
        <input
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex: Compra de esmaltes"
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Categoria</label>
        <input
          list="categorias-despesa"
          value={categoryName}
          onChange={(e) => setCategoryName(e.target.value)}
          placeholder="Ex: Materiais"
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
        <datalist id="categorias-despesa">
          {DEFAULT_CATEGORIES.map((c) => <option key={c} value={c} />)}
        </datalist>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Valor (R$)</label>
          <input
            type="number"
            required
            min={0}
            step={0.01}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Data</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Forma de pagamento</label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          >
            <option value="pix">Pix</option>
            <option value="dinheiro">Dinheiro</option>
            <option value="cartao">Cartão</option>
            <option value="outro">Outro</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ExpenseFormData["status"])}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          >
            <option value="pago">Pago</option>
            <option value="pendente">Pendente</option>
            <option value="parcial">Parcial</option>
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-60"
      >
        {saving ? "Salvando..." : "Salvar despesa"}
      </button>

      {initial && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="w-full rounded-xl border border-danger py-3 font-semibold text-danger disabled:opacity-60"
        >
          {deleting ? "Excluindo..." : "Excluir despesa"}
        </button>
      )}
    </form>
  );
}
