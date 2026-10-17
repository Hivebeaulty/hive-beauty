"use client";

// Edição de agendamento. Mesmos campos e regras da criação (agenda/novo):
// horários livres da profissional (ignorando o próprio agendamento), duração e
// valor do serviço quando o serviço muda. A autoridade é o banco
// (update_appointment, migration 0022): RLS, conflito de horário, agendamento
// em aberto e "alterado por outra pessoa".
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getActiveProfessionals, getAvailableSlots, type Professional } from "@/lib/hive/schedule";
import { formatDuration } from "@/lib/hive/format";
import {
  canEditAppointment,
  canManageConcluded,
  concludedErrorMessage,
  concludedExpectedFrom,
  durationMinutesOf,
  editErrorMessage,
  expectedFrom,
  hasChanges,
  type AppointmentSnapshot,
} from "@/lib/hive/appointment-edit";
import { describeChangeNotice, parseChangeNotice, type ChangeNoticeView } from "@/lib/hive/whatsapp-change-notice";
import { PAYMENT_METHOD_LABEL, SELECTABLE_PAYMENT_METHODS } from "@/lib/hive/payment-methods";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckCircle2, Clock, Info, MessageCircle } from "lucide-react";

type Option = { id: string; name: string };
type ServiceOption = { id: string; name: string; duration_minutes: number; price: number; active: boolean };
type Done = { changed: boolean; notice: ChangeNoticeView | null; clientChanged: boolean; concluded?: boolean };

const SELECT = "client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price, status, notes";

export default function EditarAgendamentoPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { companyId, role } = useCompany();

  const [original, setOriginal] = useState<AppointmentSnapshot | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [clients, setClients] = useState<Option[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);

  const [clientId, setClientId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState(0);
  const [notes, setNotes] = useState("");
  // atendimento concluído (0030): recebimento junto
  const [origPay, setOrigPay] = useState<{ status: string; method: string } | null>(null);
  const [payStatus, setPayStatus] = useState("pago");
  const [payMethod, setPayMethod] = useState("pix");

  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  // Carrega o agendamento e preenche o formulário com o que está salvo.
  const loadAppointment = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from("appointments").select(SELECT).eq("id", id).maybeSingle();
    if (!data) {
      setNotFound(true);
      return null;
    }
    const a = { ...(data as AppointmentSnapshot), price: Number((data as AppointmentSnapshot).price) };
    const start = new Date(a.scheduled_start);
    setOriginal(a);
    setClientId(a.client_id);
    setServiceId(a.service_id);
    setProfessionalId(a.professional_member_id);
    setDate(format(start, "yyyy-MM-dd"));
    setTime(format(start, "HH:mm"));
    setDuration(durationMinutesOf(a));
    setPrice(a.price);
    setNotes(a.notes ?? "");
    if (a.status === "concluido") {
      const { data: pay } = await supabase.from("payments").select("status, method").eq("appointment_id", id).maybeSingle();
      const pp = (pay as { status: string; method: string } | null) ?? null;
      setOrigPay(pp);
      if (pp) {
        setPayStatus(pp.status);
        setPayMethod(pp.method);
      }
    }
    return a;
  }, [id]);

  // Listas: ativos + o que o agendamento já usa (mesmo se arquivado/inativo depois).
  useEffect(() => {
    let alive = true;
    (async () => {
      const a = await loadAppointment();
      if (!alive || !a) return;
      const supabase = createClient();
      const [{ data: cl }, { data: sv }, profs] = await Promise.all([
        supabase.from("clients").select("id, name, archived_at").eq("company_id", companyId).order("name"),
        supabase.from("services").select("id, name, duration_minutes, price, active").eq("company_id", companyId).order("name"),
        getActiveProfessionals(supabase, companyId),
      ]);
      if (!alive) return;
      setClients(
        ((cl as (Option & { archived_at: string | null })[]) ?? []).filter((c) => !c.archived_at || c.id === a.client_id)
      );
      setServices(((sv as ServiceOption[]) ?? []).filter((s) => s.active || s.id === a.service_id));
      setProfessionals(profs);
    })();
    return () => {
      alive = false;
    };
  }, [companyId, loadAppointment]);

  function handleServiceChange(newId: string) {
    setServiceId(newId);
    const svc = services.find((s) => s.id === newId);
    // mesma regra da criação: serviço novo => duração e valor do serviço
    if (svc && newId !== original?.service_id) {
      setDuration(svc.duration_minutes);
      setPrice(Number(svc.price));
    } else if (original && newId === original.service_id) {
      setDuration(durationMinutesOf(original));
      setPrice(original.price);
    }
  }

  // Horários livres (aviso antecipado; o banco continua sendo a autoridade).
  const reloadSlots = useCallback(async () => {
    if (!professionalId || !date || !duration) {
      setSlots([]);
      return;
    }
    setSlotsLoading(true);
    const list = await getAvailableSlots({
      supabase: createClient(),
      companyId,
      professionalId,
      dateStr: date,
      durationMinutes: duration,
      excludeAppointmentId: id,
    });
    setSlots(list);
    setSlotsLoading(false);
  }, [companyId, professionalId, date, duration, id]);

  useEffect(() => {
    reloadSlots();
  }, [reloadSlots]);

  // O horário atual sempre pode ser mantido (mesmo se hoje estiver fora da grade).
  const originalTime = original ? format(new Date(original.scheduled_start), "HH:mm") : "";
  const keepsOriginalSlot =
    !!original &&
    date === format(new Date(original.scheduled_start), "yyyy-MM-dd") &&
    professionalId === original.professional_member_id &&
    duration === durationMinutesOf(original);
  const timeOptions = keepsOriginalSlot && !slots.includes(originalTime) ? [originalTime, ...slots].sort() : slots;

  const concluded = original?.status === "concluido";
  useEffect(() => {
    if (!concluded && time && !timeOptions.includes(time)) setTime("");
  }, [timeOptions, time, concluded]);

  // Concluído (0030): atendimento + recebimento juntos; nenhuma mensagem sai.
  async function saveConcluded(start: Date) {
    if (!original || !origPay) return;
    const form = { clientId, serviceId, professionalId, start, durationMinutes: duration, price, notes };
    if (!hasChanges(original, form) && payStatus === origPay.status && payMethod === origPay.method) {
      setDone({ changed: false, notice: null, clientChanged: false, concluded: true });
      return;
    }
    setSaving(true);
    setError(null);
    const { data, error: err } = await createClient().rpc("edit_concluded_appointment", {
      p_appointment_id: id,
      p_service_id: serviceId,
      p_professional_member_id: professionalId,
      p_scheduled_start: start.toISOString(),
      p_scheduled_end: new Date(start.getTime() + duration * 60000).toISOString(),
      p_price: price,
      p_payment_status: payStatus,
      p_method: payMethod,
      p_notes: notes,
      p_expected: concludedExpectedFrom(original, origPay.status),
    });
    setSaving(false);
    if (err) {
      const m = concludedErrorMessage(err.code, err.message);
      setError(m.message);
      if (m.reload) await loadAppointment();
      return;
    }
    setDone({ changed: !!(data as { changed?: boolean } | null)?.changed, notice: null, clientChanged: false, concluded: true });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!original) return;
    if (!time) {
      setError("Escolha um horário disponível.");
      return;
    }
    const start = new Date(`${date}T${time}:00`);
    const form = { clientId, serviceId, professionalId, start, durationMinutes: duration, price, notes };
    if (concluded) {
      await saveConcluded(start);
      return;
    }
    if (!hasChanges(original, form)) {
      setDone({ changed: false, notice: null, clientChanged: false });
      return;
    }
    setSaving(true);
    setError(null);
    const supabase = createClient();
    const { data, error: err } = await supabase.rpc("update_appointment", {
      p_appointment_id: id,
      p_client_id: clientId,
      p_service_id: serviceId,
      p_professional_member_id: professionalId,
      p_scheduled_start: start.toISOString(),
      p_scheduled_end: new Date(start.getTime() + duration * 60000).toISOString(),
      p_price: price,
      p_notes: notes,
      p_expected: expectedFrom(original),
    });
    if (err) {
      setSaving(false);
      const m = editErrorMessage(err.code);
      setError(m.message);
      if (m.reload) await loadAppointment();
      if (m.reloadSlots) reloadSlots();
      return;
    }
    const r = (data ?? {}) as { changed?: boolean; client_changed?: boolean };
    // Aviso à cliente (remarcação), decidido pelo banco junto com a alteração.
    // Ausente (migration não aplicada) ou erro => nada é mostrado.
    let notice: ChangeNoticeView | null = null;
    if (r.changed) {
      const { data: n, error: nErr } = await supabase.rpc("wa_get_change_notice", { p_appointment_id: id });
      if (!nErr) notice = describeChangeNotice(parseChangeNotice(n), "reschedule");
    }
    setSaving(false);
    setDone({ changed: !!r.changed, notice, clientChanged: !!r.client_changed });
  }

  if (notFound) {
    return <p className="py-10 text-center text-sm text-ink-500">Agendamento não encontrado.</p>;
  }
  if (!original) {
    return <p className="py-10 text-center text-sm text-ink-400">Carregando...</p>;
  }
  if (!canEditAppointment(original.status) && !(concluded && canManageConcluded(role) && origPay)) {
    return (
      <div className="space-y-4">
        <h1 className="page-title">Editar agendamento</h1>
        <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-400" />
          <span>
            {concluded
              ? "Atendimento concluído: só a administração da empresa pode editar."
              : "Só agendamentos em aberto ou concluídos podem ser editados. Este foi cancelado ou marcado como falta."}
          </span>
        </div>
        <Button variant="secondary" className="w-full" onClick={() => router.push(`/agenda/${id}`)}>
          Voltar
        </Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 className="size-10 text-success" />
          <h1 className="text-xl font-semibold text-ink-800">{done.changed ? "Agendamento atualizado" : "Nada foi alterado"}</h1>
        </div>
        {done.concluded && done.changed && (
          <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600" role="status">
            <Info className="mt-0.5 size-4 shrink-0 text-ink-400" />
            <span>O Financeiro já reflete a mudança. Nenhuma mensagem foi enviada para a cliente.</span>
          </div>
        )}
        {done.notice && (
          <Card>
            <div className="flex items-start gap-2.5 text-sm" role="status" data-testid="wa-change-notice">
              <MessageCircle className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden="true" />
              <p className="text-ink-600">{done.notice.text}</p>
            </div>
          </Card>
        )}
        {done.clientChanged && (
          <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
            <Info className="mt-0.5 size-4 shrink-0 text-ink-400" />
            <span>A cliente foi trocada. Nenhuma mensagem automática é enviada nesse caso; avise as duas, se precisar.</span>
          </div>
        )}
        <Button className="w-full" onClick={() => { router.push(`/agenda/${id}`); router.refresh(); }}>
          Ver agendamento
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-4">
      <h1 className="page-title">Editar agendamento</h1>

      {concluded && (
        <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-sand px-4 py-3 text-sm text-ink-700">
          <Info className="mt-0.5 size-4 shrink-0 text-gold-700" />
          <span>Atendimento concluído: as mudanças atualizam também o Financeiro. Nenhuma mensagem é enviada para a cliente.</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Select label="Cliente" required value={clientId} disabled={concluded} onChange={(e) => setClientId(e.target.value)}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        <Select label="Serviço" required value={serviceId} onChange={(e) => handleServiceChange(e.target.value)}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {formatDuration(s.duration_minutes)}
              {s.active ? "" : " (inativo)"}
            </option>
          ))}
        </Select>

        {(professionals.length > 1 || !professionals.some((p) => p.id === professionalId)) && (
          <Select label="Profissional" required value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
            {!professionals.some((p) => p.id === professionalId) && (
              <option value={professionalId} disabled>
                Profissional inativa — escolha outra
              </option>
            )}
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Input
            type="date"
            label="Data"
            required
            value={date}
            max={concluded ? format(new Date(), "yyyy-MM-dd") : undefined}
            onChange={(e) => setDate(e.target.value)}
          />
          <NumberInput integer label="Duração (min)" required value={duration} onChange={setDuration} />
        </div>

        {concluded ? (
          <Input type="time" label="Horário" required value={time} onChange={(e) => setTime(e.target.value)} />
        ) : (
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
            <Clock className="size-3.5" />
            Horário
          </label>
          {slotsLoading ? (
            <p className="text-sm text-ink-400">Calculando horários livres...</p>
          ) : timeOptions.length === 0 ? (
            <p className="text-sm text-ink-400">Nenhum horário livre nesse dia. Tente outra data.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {timeOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setTime(s)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    time === s ? "border-ink-800 bg-ink-800 text-cream" : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-50"
                  )}
                >
                  {s}
                  {keepsOriginalSlot && s === originalTime ? " · atual" : ""}
                </button>
              ))}
            </div>
          )}
        </div>

        )}

        <NumberInput label="Valor (R$)" required value={price} onChange={setPrice} />

        {concluded && (
          <div className="grid grid-cols-2 gap-3">
            <Select label="Recebimento" required value={payStatus} onChange={(e) => setPayStatus(e.target.value)}>
              <option value="pago">Pago</option>
              <option value="pendente">Pendente</option>
              {payStatus === "parcial" && <option value="parcial" disabled>Parcial (ajuste no Financeiro)</option>}
            </Select>
            <Select label="Forma de pagamento" required value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
              {!SELECTABLE_PAYMENT_METHODS.includes(payMethod as (typeof SELECTABLE_PAYMENT_METHODS)[number]) && (
                <option value={payMethod}>{PAYMENT_METHOD_LABEL[payMethod] ?? payMethod}</option>
              )}
              {SELECTABLE_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </option>
              ))}
            </Select>
          </div>
        )}

        <Textarea label="Observação (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={() => router.push(`/agenda/${id}`)} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" loading={saving} className="flex-1">
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </form>
    </div>
  );
}
