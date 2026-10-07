"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/hive/format";
import { phoneDisplay } from "@/lib/hive/phone";
import {
  closingActions,
  concludeAvailability,
  concludeErrorMessage,
  paymentStatusFor,
} from "@/lib/hive/appointment-flow";
import { ChevronLeft, Phone, StickyNote, Info, Wallet } from "lucide-react";

type AppointmentDetail = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  price: number;
  notes: string | null;
  professional_member_id: string;
  clients: { id: string; name: string; phone: string | null } | null;
  services: { name: string } | null;
};

type PaymentSummary = { status: "pago" | "pendente" | "parcial"; amount: number; paid_amount: number };

// Fluxo: agendado -> atendimento realizado -> recebido (padrão) ou recebimento
// pendente. Não há mais "Confirmar" nem "Iniciar atendimento". A decisão de
// quem/quando pode registrar está em lib/hive/appointment-flow.ts; a autoridade
// final é a RPC conclude_appointment no banco.
export default function AgendamentoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { role, memberId } = useCompany();
  const [appt, setAppt] = useState<AppointmentDetail | null>(null);
  const [payment, setPayment] = useState<PaymentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConclude, setShowConclude] = useState(false);
  const [finalPrice, setFinalPrice] = useState(0);
  const [method, setMethod] = useState<"pix" | "dinheiro" | "cartao" | "outro">("pix");
  const [pending, setPending] = useState(false); // "Recebimento pendente" — desligado = recebido
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // O botão "Atendimento realizado" aparece quando chega a hora do atendimento,
  // mesmo com a tela já aberta.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("appointments")
      .select(
        "id, scheduled_start, scheduled_end, status, price, notes, professional_member_id, clients(id, name, phone), services(name)"
      )
      .eq("id", id)
      .maybeSingle();
    const a = data as unknown as AppointmentDetail | null;
    setAppt(a);
    if (a) setFinalPrice(Number(a.price));

    // Situação do recebimento de um atendimento já concluído. A RLS só devolve
    // pagamentos a owner/admin; para os demais papéis a linha simplesmente não
    // vem e nada é exibido.
    if (a?.status === "concluido") {
      const { data: p } = await supabase
        .from("payments")
        .select("status, amount, paid_amount")
        .eq("appointment_id", id)
        .maybeSingle();
      setPayment((p as PaymentSummary | null) ?? null);
    } else {
      setPayment(null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeStatus(status: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    // .select("id"): a RLS pode filtrar a linha sem devolver erro; só é sucesso
    // se uma linha foi realmente atualizada.
    const { data, error } = await supabase.from("appointments").update({ status }).eq("id", id).select("id");
    setBusy(false);
    if (error || !data || data.length === 0) {
      setError("Não foi possível atualizar o status.");
      return;
    }
    load();
  }

  async function handleConclude(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // evita duplo envio
    setBusy(true);
    setError(null);
    const supabase = createClient();
    // A RPC é a ÚNICA criadora do pagamento (uma transação: atendimento +
    // pagamento). O frontend nunca insere em `payments` para atendimentos.
    const { error } = await supabase.rpc("conclude_appointment", {
      p_appointment_id: id,
      p_final_price: finalPrice,
      p_method: method,
      p_payment_status: paymentStatusFor(pending),
      p_paid_amount: null,
    });
    setBusy(false);
    if (error) {
      const { message, reload } = concludeErrorMessage(error.code);
      setError(message);
      if (reload) {
        setShowConclude(false);
        load(); // mostra o estado real (ex.: outro aparelho já registrou)
      }
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

  const availability = concludeAvailability({
    status: appt.status,
    scheduledStart: appt.scheduled_start,
    professionalMemberId: appt.professional_member_id,
    role,
    memberId,
    now,
  });
  const closing = closingActions({ status: appt.status, scheduledStart: appt.scheduled_start, now });
  const phoneText = phoneDisplay(appt.clients?.phone);

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
        {payment && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-ink-400">
              <Wallet className="size-3.5" />
              Recebimento
            </span>
            <Badge tone={payment.status === "pago" ? "success" : "warning"}>
              {payment.status === "pago" ? "Recebido" : payment.status === "parcial" ? "Parcial" : "Pendente"}
            </Badge>
          </div>
        )}
        {phoneText && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-ink-400">
              <Phone className="size-3.5" />
              Telefone
            </span>
            <span className="font-medium text-ink-800">{phoneText}</span>
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
          {availability.state === "available" && (
            <Button
              onClick={() => {
                setPending(false);
                setError(null);
                setShowConclude(true);
              }}
              className="w-full !bg-success hover:!bg-success"
            >
              Atendimento realizado
            </Button>
          )}

          {availability.state === "not_started" && (
            <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-400" />
              <span>
                O registro do atendimento fica disponível a partir das{" "}
                {availability.startsAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}, horário do
                agendamento.
              </span>
            </div>
          )}

          {availability.state === "no_permission" && (
            <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-400" />
              <span>
                Quem registra o atendimento é a profissional responsável ou a administração do negócio.
              </span>
            </div>
          )}

          {closing.map((a) => (
            <Button
              key={a.status}
              variant={a.status === "cancelado" ? "secondary" : "danger"}
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
          <h2 className="font-semibold text-ink-800">Atendimento realizado</h2>
          <NumberInput label="Valor final (R$)" required value={finalPrice} onChange={setFinalPrice} />
          <Select label="Forma de pagamento" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="pix">Pix</option>
            <option value="dinheiro">Dinheiro</option>
            <option value="cartao">Cartão</option>
            <option value="outro">Outro</option>
          </Select>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-ink-100 px-4 py-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-ink-800">Recebimento pendente</p>
              <p className="text-xs text-ink-400">
                {pending
                  ? "O valor fica como pendente no Financeiro e só entra como recebido quando você marcar como recebido."
                  : "Desligado: o valor entra como recebido agora."}
              </p>
            </div>
            <Switch checked={pending} onChange={setPending} disabled={busy} label="Recebimento pendente" />
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowConclude(false)}
              disabled={busy}
              className="flex-1"
            >
              Voltar
            </Button>
            <Button type="submit" loading={busy} className="flex-1">
              {busy ? "Salvando..." : pending ? "Registrar (pendente)" : "Registrar como recebido"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
