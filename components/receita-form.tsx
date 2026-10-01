"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

type ClientOption = { id: string; name: string };

type PaymentFormData = {
  id: string;
  description: string;
  client_id: string;
  amount: number;
  paid_amount: number | null;
  method: string;
  status: "pago" | "pendente" | "parcial";
  paid_at?: string | null;
};

// Mesma lógica de sempre (mesmos campos, mesmo cálculo de paid_amount por
// status, mesmo paid_at automático) — só migrado pros componentes novos.
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
      // Preserva a data em que o pagamento REALMENTE entrou: reeditar um
      // recebimento já pago (ex.: corrigir a descrição) não pode empurrá-lo
      // pra "hoje" e mudar o período em que ele conta.
      paid_at: status === "pago" ? (initial?.paid_at ?? new Date().toISOString()) : null,
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
      <Input
        label="Descrição"
        required
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Ex: Venda de produto, sinal de pacote..."
        hint="Recebimentos de atendimentos são registrados automaticamente ao concluir na Agenda."
      />

      <Select label="Cliente (opcional)" value={clientId} onChange={(e) => setClientId(e.target.value)}>
        <option value="">Nenhuma</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>

      <div className="grid grid-cols-2 gap-3">
        <NumberInput label="Valor (R$)" required value={amount} onChange={setAmount} />
        <Select label="Forma de pagamento" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="pix">Pix</option>
          <option value="dinheiro">Dinheiro</option>
          <option value="cartao">Cartão</option>
          <option value="outro">Outro</option>
        </Select>
      </div>

      <Select
        label="Status do pagamento"
        value={status}
        onChange={(e) => setStatus(e.target.value as PaymentFormData["status"])}
      >
        <option value="pago">Pago</option>
        <option value="pendente">Pendente</option>
        <option value="parcial">Parcial</option>
      </Select>

      {status === "parcial" && (
        <NumberInput label="Quanto já foi pago (R$)" value={paidAmount} onChange={setPaidAmount} />
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <Button type="submit" loading={saving} className="w-full">
        {saving ? "Salvando..." : "Salvar recebimento"}
      </Button>

      {initial && (
        <Button type="button" variant="secondary" onClick={handleDelete} loading={deleting} className="w-full !border-danger !text-danger">
          {deleting ? "Excluindo..." : "Excluir recebimento"}
        </Button>
      )}
    </form>
  );
}
