"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { StatusBadge } from "@/components/ui/status-badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/hive/format";
import { ChevronLeft, Phone, StickyNote } from "lucide-react";

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
const NEXT_ACTIONS: Record<string, { status: string; label: string; variant: "secondary" | "danger" }[]> = {
  agendado: [
    { status: "confirmado", label: "Confirmar", variant: "secondary" },
    { status: "em_atendimento", label: "Iniciar atendimento", variant: "secondary" },
    { status: "cancelado", label: "Cancelar", variant: "danger" },
  ],
  confirmado: [
    { status: "em_atendimento", label: "Iniciar atendimento", variant: "secondary" },
    { status: "nao_compareceu", label: "Não compareceu", variant: "danger" },
    { status: "cancelado", label: "Cancelar", variant: "danger" },
  ],
  em_atendimento: [], // conclusão tem fluxo próprio (registra pagamento) abaixo
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

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (!appt) return <p className="text-center text-sm text-ink-400">Agendamento não encontrado.</p>;

  const actions = NEXT_ACTIONS[appt.status] ?? [];

  return (
    <div className="space-y-5 pb-4">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800"
      >
        <ChevronLeft className="size-4" />
        Voltar
      </button>

      <div>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">{appt.clients?.name}</h1>
          <StatusBadge status={appt.status} />
        </div>
        <p className="text-sm text-ink-400">{appt.services?.name}</p>
      </div>

      <Card className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-ink-400">Data</span>
          <span className="font-medium text-ink-800">
            {new Date(appt.scheduled_start).toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-ink-400">Valor</span>
          <span className="font-medium text-ink-800">{formatMoney(appt.price)}</span>
        </div>
        {appt.clients?.phone && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-ink-400">
              <Phone className="size-3.5" />
              Telefone
            </span>
            <span className="font-medium text-ink-800">{appt.clients.phone}</span>
          </div>
        )}
        {appt.notes && (
          <div className="border-t border-ink-100 pt-3 text-sm">
            <p className="mb-1 flex items-center gap-1.5 text-ink-400">
              <StickyNote className="size-3.5" />
              Observação
            </p>
            <p className="text-ink-700">{appt.notes}</p>
          </div>
        )}
      </Card>

      {error && <p className="text-sm text-danger">{error}</p>}

      {!showConclude && (
        <div className="space-y-2">
          {appt.status === "em_atendimento" && (
            <Button
              onClick={() => {
                setPaidAmount(finalPrice);
                setShowConclude(true);
              }}
              className="w-full !bg-success hover:!bg-success"
            >
              Concluir atendimento
            </Button>
          )}
          {actions.map((a) => (
            <Button
              key={a.status}
              variant={a.variant}
              disabled={busy}
              onClick={() => changeStatus(a.status)}
              className="w-full"
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}

      {showConclude && (
        <form onSubmit={handleConclude} className="space-y-4 rounded-lg border border-ink-100 bg-surface p-5">
          <h2 className="font-semibold text-ink-800">Concluir atendimento</h2>
          <Input
            type="number"
            label="Valor final (R$)"
            required
            min={0}
            step={0.01}
            value={finalPrice}
            onChange={(e) => setFinalPrice(Number(e.target.value))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Pagamento" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="pix">Pix</option>
              <option value="dinheiro">Dinheiro</option>
              <option value="cartao">Cartão</option>
              <option value="outro">Outro</option>
            </Select>
            <Select label="Status" value={payStatus} onChange={(e) => setPayStatus(e.target.value as typeof payStatus)}>
              <option value="pago">Pago</option>
              <option value="pendente">Pendente</option>
              <option value="parcial">Parcial</option>
            </Select>
          </div>
          {payStatus === "parcial" && (
            <Input
              type="number"
              label="Quanto já foi pago (R$)"
              min={0}
              max={finalPrice}
              step={0.01}
              value={paidAmount}
              onChange={(e) => setPaidAmount(Number(e.target.value))}
            />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setShowConclude(false)} className="flex-1">
              Cancelar
            </Button>
            <Button type="submit" loading={busy} className="flex-1">
              {busy ? "Salvando..." : "Confirmar"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
