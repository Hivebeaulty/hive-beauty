"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { STATUS_LABEL, STATUS_COLOR } from "@/lib/hive/status";

type AppointmentDetail = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  price: number;
  notes: string | null;
  clients: { id: string; name: string; phone: string | null } | null;
  services: { name: string } | null;
};

// "Iniciar atendimento" fica disponível tanto em agendado quanto em
// confirmado — a confirmação é útil pra organização, mas não pode ser um
// passo obrigatório que atrapalhe um início rápido no dia a dia.
const NEXT_ACTIONS: Record<string, { status: string; label: string }[]> = {
  agendado: [
    { status: "confirmado", label: "Confirmar" },
    { status: "em_atendimento", label: "Iniciar atendimento" },
    { status: "cancelado", label: "Cancelar" },
  ],
  confirmado: [
    { status: "em_atendimento", label: "Iniciar atendimento" },
    { status: "nao_compareceu", label: "Não compareceu" },
    { status: "cancelado", label: "Cancelar" },
  ],
  em_atendimento: [], // conclusão tem fluxo próprio (registra pagamento)
};

export default function AgendamentoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [appt, setAppt] = useState<AppointmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConclude, setShowConclude] = useState(false);
  const [finalPrice, setFinalPrice] = useState(0);
  const [method, setMethod] = useState<"pix" | "dinheiro" | "cartao" | "outro">("pix");
  const [payStatus, setPayStatus] = useState<"pago" | "pendente" | "parcial">("pago");
  const [paidAmount, setPaidAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("appointments")
      .select("id, scheduled_start, scheduled_end, status, price, notes, clients(id, name, phone), services(name)")
      .eq("id", id)
      .maybeSingle();
    const a = data as unknown as AppointmentDetail | null;
    setAppt(a);
    if (a) setFinalPrice(Number(a.price));
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeStatus(status: string) {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.from("appointments").update({ status }).eq("id", id);
    setBusy(false);
    if (error) {
      setError("Não foi possível atualizar o status.");
      return;
    }
    load();
  }

  async function handleConclude(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.rpc("conclude_appointment", {
      p_appointment_id: id,
      p_final_price: finalPrice,
      p_method: method,
      p_payment_status: payStatus,
      p_paid_amount: payStatus === "parcial" ? paidAmount : null,
    });
    setBusy(false);
    if (error) {
      setError("Não foi possível concluir o atendimento.");
      return;
    }
    setShowConclude(false);
    load();
  }

  if (loading) return <p className="text-center text-sm text-charcoal-500">Carregando...</p>;
  if (!appt) return <p className="text-center text-sm text-charcoal-500">Agendamento não encontrado.</p>;

  const actions = NEXT_ACTIONS[appt.status] ?? [];

  return (
    <div className="space-y-6">
      <div>
        <button onClick={() => router.back()} className="mb-2 text-sm text-plum-500">‹ Voltar</button>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-charcoal-900">{appt.clients?.name}</h1>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLOR[appt.status]}`}>
            {STATUS_LABEL[appt.status]}
          </span>
        </div>
        <p className="text-sm text-charcoal-700">{appt.services?.name}</p>
      </div>

      <section className="space-y-2 rounded-2xl bg-white p-5 shadow-sm">
        <p className="text-sm text-charcoal-700">
          <span className="font-semibold text-charcoal-900">Data: </span>
          {new Date(appt.scheduled_start).toLocaleString("pt-BR", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
          })}
        </p>
        <p className="text-sm text-charcoal-700">
          <span className="font-semibold text-charcoal-900">Valor: </span>
          R$ {Number(appt.price).toFixed(2)}
        </p>
        {appt.clients?.phone && (
          <p className="text-sm text-charcoal-700">
            <span className="font-semibold text-charcoal-900">Telefone: </span>
            {appt.clients.phone}
          </p>
        )}
        {appt.notes && (
          <p className="text-sm text-charcoal-700">
            <span className="font-semibold text-charcoal-900">Observação: </span>
            {appt.notes}
          </p>
        )}
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}

      {!showConclude && (
        <div className="space-y-2">
          {appt.status === "em_atendimento" && (
            <button
              onClick={() => {
                setPaidAmount(finalPrice);
                setShowConclude(true);
              }}
              className="w-full rounded-xl bg-success py-3 font-semibold text-white"
            >
              Concluir atendimento
            </button>
          )}
          {actions.map((a) => (
            <button
              key={a.status}
              disabled={busy}
              onClick={() => changeStatus(a.status)}
              className="w-full rounded-xl border border-blush-200 bg-white py-3 font-semibold text-charcoal-900 disabled:opacity-60"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {showConclude && (
        <form onSubmit={handleConclude} className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-charcoal-900">Concluir atendimento</h2>
          <div>
            <label className="mb-1 block text-sm font-medium text-charcoal-700">Valor final (R$)</label>
            <input
              type="number"
              required
              min={0}
              step={0.01}
              value={finalPrice}
              onChange={(e) => setFinalPrice(Number(e.target.value))}
              className="w-full rounded-xl border border-blush-200 bg-blush-50 px-4 py-3 outline-none focus:border-plum-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-charcoal-700">Pagamento</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
                className="w-full rounded-xl border border-blush-200 bg-blush-50 px-4 py-3 outline-none focus:border-plum-500"
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
                value={payStatus}
                onChange={(e) => setPayStatus(e.target.value as typeof payStatus)}
                className="w-full rounded-xl border border-blush-200 bg-blush-50 px-4 py-3 outline-none focus:border-plum-500"
              >
                <option value="pago">Pago</option>
                <option value="pendente">Pendente</option>
                <option value="parcial">Parcial</option>
              </select>
            </div>
          </div>
          {payStatus === "parcial" && (
            <div>
              <label className="mb-1 block text-sm font-medium text-charcoal-700">Quanto já foi pago (R$)</label>
              <input
                type="number"
                min={0}
                max={finalPrice}
                step={0.01}
                value={paidAmount}
                onChange={(e) => setPaidAmount(Number(e.target.value))}
                className="w-full rounded-xl border border-blush-200 bg-blush-50 px-4 py-3 outline-none focus:border-plum-500"
              />
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowConclude(false)}
              className="flex-1 rounded-xl border border-blush-200 py-3 font-semibold text-charcoal-700"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Salvando..." : "Confirmar"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
