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
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/hive/format";
import { phoneDisplay } from "@/lib/hive/phone";
import {
  canDeleteAppointment,
  canManageAppointmentPayment,
  canMarkPaymentPending,
  closingActions,
  concludeAvailability,
  concludeErrorMessage,
  deleteErrorMessage,
  markPendingErrorMessage,
  noShowErrorMessage,
  parseNoShowEligibility,
  paymentStatusFor,
  paymentUpdateErrorMessage,
  statusChangeErrorMessage,
} from "@/lib/hive/appointment-flow";
import { DEFAULT_PAYMENT_METHOD, paymentMethodOptions } from "@/lib/hive/payment-methods";
import { describeConfirmation, parseConfirmation, type ConfirmationView } from "@/lib/hive/whatsapp-confirmation";
import { WhatsappConfirmationStatus } from "@/components/whatsapp-confirmation-status";
import { ChevronLeft, Phone, StickyNote, Info, Wallet, Trash2, AlertTriangle, UserX } from "lucide-react";

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

type PaymentSummary = { status: "pago" | "pendente" | "parcial"; amount: number; paid_amount: number; method: string };

// Fluxo: agendado -> atendimento realizado -> recebido (padrão) ou recebimento
// pendente. Não há mais "Confirmar" nem "Iniciar atendimento". A decisão de
// quem/quando pode registrar está em lib/hive/appointment-flow.ts; a autoridade
// final é a RPC conclude_appointment no banco.
export default function AgendamentoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { role, memberId } = useCompany();
  const toast = useToast();
  const [appt, setAppt] = useState<AppointmentDetail | null>(null);
  const [payment, setPayment] = useState<PaymentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConclude, setShowConclude] = useState(false);
  const [finalPrice, setFinalPrice] = useState(0);
  const [method, setMethod] = useState<string>(DEFAULT_PAYMENT_METHOD); // PIX por padrão
  const [showDelete, setShowDelete] = useState(false);
  const [deleteAck, setDeleteAck] = useState(false);
  const [noShowEligible, setNoShowEligible] = useState(false); // concluído automaticamente e recebimento intacto
  const [showNoShow, setShowNoShow] = useState(false);
  const [pending, setPending] = useState(false); // "Recebimento pendente" — desligado = recebido
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [confirmation, setConfirmation] = useState<ConfirmationView | null>(null); // WhatsApp automático (0018)

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

    // Recebimento do atendimento concluído, via RPC: a profissional dona do
    // atendimento não lê a tabela payments (RLS admin-only), mas a RPC a autoriza.
    // Quem não pode vê (ex.: recepção) ou RPC indisponível => nada é exibido.
    if (a?.status === "concluido") {
      const { data: p } = await supabase.rpc("get_appointment_payment", { p_appointment_id: id });
      const row = (Array.isArray(p) ? p[0] : p) as
        | { pay_status: PaymentSummary["status"]; pay_amount: number; pay_paid_amount: number; pay_method: string }
        | null
        | undefined;
      setPayment(
        row
          ? {
              status: row.pay_status,
              amount: Number(row.pay_amount),
              paid_amount: Number(row.pay_paid_amount),
              method: row.pay_method,
            }
          : null
      );
      // Falta depois da conclusão automática: o banco diz se ainda é possível
      // (recebimento automático e nunca alterado). Erro/sem permissão => oculto.
      const { data: elig, error: eligError } = await supabase.rpc("get_appointment_no_show_eligibility", {
        p_appointment_id: id,
      });
      setNoShowEligible(!eligError && parseNoShowEligibility(elig).eligible);
    } else {
      setNoShowEligible(false);
      setPayment(null);
    }
    // Situação da confirmação automática por WhatsApp. Erro ou 0018 ausente => oculto.
    if (a) {
      const { data: conf, error: confError } = await supabase.rpc("wa_get_appointment_confirmation", { p_appointment_id: id });
      setConfirmation(confError ? null : describeConfirmation(parseConfirmation(conf)));
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
      // 22023: o atendimento já foi concluído (outro aparelho ou a conclusão
      // automática) e o banco recusou. Mostra o estado real.
      const { message, reload } = statusChangeErrorMessage(error?.code);
      setError(message);
      if (reload) load();
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

  // Altera a forma de pagamento (e, se pedido, marca como recebido) no pagamento
  // EXISTENTE — nunca cria um segundo. A regra vive na RPC.
  async function updatePayment(newMethod: string, markReceived: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("update_appointment_payment", {
      p_appointment_id: id,
      p_method: newMethod,
      p_mark_received: markReceived,
    });
    setBusy(false);
    if (error) {
      setError(paymentUpdateErrorMessage(error.code));
      load();
      return;
    }
    toast.success(markReceived ? "Recebimento marcado como recebido." : "Forma de pagamento atualizada.");
    load();
  }

  // Recebido -> pendente, no MESMO recebimento (a regra vive na RPC).
  async function markPending() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("mark_appointment_payment_pending", { p_appointment_id: id });
    setBusy(false);
    if (error) {
      setError(markPendingErrorMessage(error.code));
      load();
      return;
    }
    toast.success("Recebimento marcado como pendente.");
    load();
  }

  // Concluído automaticamente -> não compareceu: remove o recebimento automático
  // (só se ele nunca foi alterado). Tudo numa transação no banco.
  async function handleNoShow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("reclassify_appointment_as_no_show", { p_appointment_id: id });
    setBusy(false);
    setShowNoShow(false);
    if (error) {
      const { message, reload } = noShowErrorMessage(error.code);
      setError(message);
      if (reload) load();
      return;
    }
    toast.success("Atendimento marcado como não compareceu.");
    load();
  }

  async function handleDelete() {
    if (busy || !deleteAck) return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("delete_appointment", { p_appointment_id: id });
    setBusy(false);
    if (error) {
      setShowDelete(false);
      setError(deleteErrorMessage(error.code));
      load();
      return;
    }
    toast.success("Atendimento excluído.");
    router.push("/agenda");
    router.refresh();
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
  const canManagePayment = canManageAppointmentPayment({
    role,
    memberId,
    professionalMemberId: appt.professional_member_id,
  });
  const canDelete = canDeleteAppointment(role);

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
        {phoneText && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-ink-400">
              <Phone className="size-3.5" />
              Telefone
            </span>
            <span className="font-medium text-ink-800">{phoneText}</span>
          </div>
        )}
        {confirmation && (
          <div className="border-t border-ink-100 pt-3">
            <WhatsappConfirmationStatus view={confirmation} />
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
                setMethod(DEFAULT_PAYMENT_METHOD); // cada registro começa em PIX
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
          <Select label="Forma de pagamento" value={method} onChange={(e) => setMethod(e.target.value)}>
            {paymentMethodOptions(method).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
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

      {/* Atendimento concluído: recebimento (alterar forma / marcar recebido) */}
      {appt.status === "concluido" && payment && canManagePayment && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-medium text-ink-800">
              <Wallet className="size-4 text-ink-400" />
              Recebimento
            </span>
            <Badge tone={payment.status === "pago" ? "success" : "warning"}>
              {payment.status === "pago" ? "Recebido" : payment.status === "parcial" ? "Parcial" : "Pendente"}
            </Badge>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-ink-400">Valor</span>
            <span className="font-medium text-ink-800">{formatMoney(payment.amount)}</span>
          </div>
          <Select
            label="Forma de pagamento"
            value={payment.method}
            disabled={busy}
            onChange={(e) => updatePayment(e.target.value, false)}
          >
            {paymentMethodOptions(payment.method).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {canMarkPaymentPending(payment.status) && (
            <div className="space-y-1.5">
              <Button variant="secondary" className="w-full" disabled={busy} onClick={markPending}>
                Marcar como pendente
              </Button>
              <p className="text-xs text-ink-400">Use se a cliente ainda não pagou. O valor sai de recebido e vai para pendente.</p>
            </div>
          )}
          {payment.status !== "pago" && (
            <div className="space-y-1.5">
              <Button
                variant="secondary"
                className="w-full"
                disabled={busy}
                onClick={() => updatePayment(payment.method, true)}
              >
                Marcar como recebido
              </Button>
              <p className="text-xs text-ink-400">
                Enquanto estiver pendente, este valor não entra como recebido nem no resultado de caixa.
              </p>
            </div>
          )}
        </Card>
      )}

      {/* Concluído automaticamente, recebimento intacto: registrar falta */}
      {appt.status === "concluido" && payment && canManagePayment && noShowEligible && (
        <Button variant="secondary" className="w-full" disabled={busy} onClick={() => setShowNoShow(true)}>
          <UserX className="size-4" />
          Cliente não compareceu
        </Button>
      )}

      <Modal open={showNoShow} onClose={() => !busy && setShowNoShow(false)} title="Cliente não compareceu">
        <div className="space-y-4">
          <p className="text-sm text-ink-700">
            Este atendimento foi concluído automaticamente no horário de término. Ao confirmar:
          </p>
          <ul className="space-y-1.5 text-sm text-ink-500">
            <li>O atendimento passa para &quot;Não compareceu&quot;.</li>
            <li>
              {payment
                ? `O recebimento automático de ${formatMoney(payment.amount)} é removido do Financeiro.`
                : "O recebimento automático é removido do Financeiro."}
            </li>
            <li>A alteração fica registrada no histórico do atendimento.</li>
          </ul>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setShowNoShow(false)} disabled={busy}>
              Voltar
            </Button>
            <Button variant="danger" className="flex-1" onClick={handleNoShow} loading={busy}>
              Confirmar falta
            </Button>
          </div>
        </div>
      </Modal>

      {/* Atendimento concluído: excluir (destrutivo, só administração) */}
      {appt.status === "concluido" && canDelete && (
        <div className="border-t border-ink-100 pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            onClick={() => {
              setDeleteAck(false);
              setShowDelete(true);
            }}
          >
            <Trash2 className="size-4" />
            Excluir atendimento
          </Button>
        </div>
      )}

      <Modal open={showDelete} onClose={() => !busy && setShowDelete(false)} title="Excluir atendimento">
        <div className="space-y-4">
          <p className="text-sm text-ink-700">
            Você vai excluir o atendimento de <strong className="font-semibold">{appt.clients?.name}</strong>
            {appt.services?.name ? ` (${appt.services.name})` : ""}.
          </p>
          <ul className="space-y-1.5 text-sm text-ink-500">
            <li>
              {payment
                ? `O recebimento de ${formatMoney(payment.amount)} (${
                    payment.status === "pago" ? "recebido" : "pendente"
                  }) também será removido do Financeiro.`
                : "Se houver recebimento ligado a ele, será removido do Financeiro."}
            </li>
            <li>Dashboard, Financeiro e Relatórios passam a refletir os dados que restarem.</li>
            <li>Outros atendimentos e recebimentos não são alterados.</li>
          </ul>
          <div className="flex items-start gap-2.5 rounded-lg bg-danger/10 px-3.5 py-3 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>Esta ação não pode ser desfeita. Use apenas para corrigir um lançamento incorreto.</span>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-ink-200 p-3 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={deleteAck}
              onChange={(e) => setDeleteAck(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-ink-800"
            />
            <span>Entendi e quero excluir este atendimento.</span>
          </label>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setShowDelete(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="danger" className="flex-1" onClick={handleDelete} disabled={!deleteAck} loading={busy}>
              Excluir definitivamente
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
