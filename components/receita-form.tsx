"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";

type ClientOption = { id: string; name: string };

type PaymentFormData = {
  id: string;
  description: string;
  client_id: string;
  amount: number;
  paid_amount: number | null;
  method: string;
  status: "pago" | "pendente" | "parcial";
};

export function ReceitaForm({ initial }: { initial?: PaymentFormData }) {
  const router = useRouter();
  const { companyId } = useCompany();
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [clientId, setClientId] = useState(initial?.client_id ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? 0);
  const [paidAmount, setPaidAmount] = useState(initial?.paid_amount ?? 0);
  const [method, setMethod] = useState(initial?.method ?? "pix");
  const [status, setStatus] = useState<PaymentFormData["status"]>(initial?.status ?? "pago");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("clients")
      .select("id, name")
      .eq("company_id", companyId)
      .order("name")
      .then(({ data }) => setClients(data ?? []));
  }, [companyId]);

  function effectivePaidAmount() {
    if (status === "pago") return amount;
    if (status === "pendente") return 0;
    return paidAmount;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const supabase = createClient();

    const payload = {
      company_id: companyId,
      description,
      client_id: clientId || null,
      amount,
      paid_amount: effectivePaidAmount(),
      method,
      status,
      paid_at: status === "pago" ? new Date().toISOString() : null,
    };

    const { error } = initial
      ? await supabase.from("payments").update(payload).eq("id", initial.id)
      : await supabase.from("payments").insert(payload);

    setSaving(false);
    if (error) {
      setError("Não foi possível salvar. Tente novamente.");
      return;
    }
    router.push("/financeiro/receitas");
    router.refresh();
  }

  async function handleDelete() {
    if (!initial) return;
    if (!confirm("Excluir este recebimento? Essa ação não pode ser desfeita.")) return;
    setDeleting(true);
    const supabase = createClient();
    const { error } = await supabase.from("payments").delete().eq("id", initial.id);
    setDeleting(false);
    if (error) {
      setError("Não foi possível excluir.");
      return;
    }
    router.push("/financeiro/receitas");
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
          placeholder="Ex: Venda de produto, sinal de pacote..."
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
        <p className="mt-1 text-xs text-charcoal-500">
          Recebimentos de atendimentos são registrados automaticamente ao concluir na Agenda.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Cliente (opcional)</label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        >
          <option value="">Nenhuma</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
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
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Status do pagamento</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as PaymentFormData["status"])}
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        >
          <option value="pago">Pago</option>
          <option value="pendente">Pendente</option>
          <option value="parcial">Parcial</option>
        </select>
      </div>

      {status === "parcial" && (
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Quanto já foi pago (R$)</label>
          <input
            type="number"
            min={0}
            max={amount}
            step={0.01}
            value={paidAmount}
            onChange={(e) => setPaidAmount(Number(e.target.value))}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-60"
      >
        {saving ? "Salvando..." : "Salvar recebimento"}
      </button>

      {initial && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="w-full rounded-xl border border-danger py-3 font-semibold text-danger disabled:opacity-60"
        >
          {deleting ? "Excluindo..." : "Excluir recebimento"}
        </button>
      )}
    </form>
  );
}
