"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getActiveProfessionals, getAvailableSlots, hasAnyBusinessHours, type Professional } from "@/lib/hive/schedule";
import { formatDuration } from "@/lib/hive/format";
import { buildConfirmationMessage } from "@/lib/hive/appointment-message";
import { resolveSignatureName } from "@/lib/hive/display-name";
import { whatsappChatLink, whatsappReach, type WhatsappReach } from "@/lib/hive/phone";
import { describeConfirmation, parseConfirmation, type ConfirmationView } from "@/lib/hive/whatsapp-confirmation";
import { WhatsappConfirmationStatus } from "@/components/whatsapp-confirmation-status";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Clock, AlertTriangle, CheckCircle2, MessageCircle, Info } from "lucide-react";

type ClientOption = { id: string; name: string; phone: string | null; phone_normalized: string | null };

// O que a tela de confirmação mostra DEPOIS que o banco confirmou o agendamento.
type CreatedAppointment = {
  id: string;
  clientId: string;
  clientName: string;
  serviceName: string;
  startsAt: Date;
  professionalName: string | null;
  whatsappUrl: string | null;
  reach: WhatsappReach;
  /** Confirmação automática (0018). null = sem automação: só o envio manual, como sempre. */
  confirmation: ConfirmationView | null;
};
type ServiceOption = { id: string; name: string; duration_minutes: number; price: number };

export default function NovoAgendamentoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { companyId, companyName, memberId } = useCompany();

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);

  const [clientId, setClientId] = useState(searchParams.get("cliente") || "");
  const [serviceId, setServiceId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [date, setDate] = useState(searchParams.get("data") || format(new Date(), "yyyy-MM-dd"));
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState(0);
  const [notes, setNotes] = useState("");

  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [hoursConfigured, setHoursConfigured] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedAppointment | null>(null);
  // Como cada profissional quer ser chamada (assina a mensagem). Se a função do
  // banco ainda não existir, fica vazio e usamos o 1º nome cadastrado.
  const [displayNames, setDisplayNames] = useState<Map<string, { display: string | null; full: string | null }>>(
    new Map()
  );

  // Dados de apoio — clientes, serviços ativos e profissionais ativas.
  useEffect(() => {
    const supabase = createClient();
    // Cliente arquivada não recebe novos atendimentos (o histórico dela segue intacto).
    supabase.from("clients").select("id, name, phone, phone_normalized").eq("company_id", companyId).is("archived_at", null).order("name").then(({ data }) => setClients(data ?? []));
    supabase
      .from("services")
      .select("id, name, duration_minutes, price")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name")
      .then(({ data }) => setServices((data as ServiceOption[]) ?? []));
    getActiveProfessionals(supabase, companyId).then((list) => {
      setProfessionals(list);
      // Uma só profissional ativa -> seleciona sozinha, sem criar etapa no
      // formulário. Duas ou mais -> preferimos quem está logada, se for
      // uma delas; senão a usuária escolhe.
      if (list.length === 1) setProfessionalId(list[0].id);
      else if (list.some((p) => p.id === memberId)) setProfessionalId(memberId);
    });
    hasAnyBusinessHours(supabase, companyId).then(setHoursConfigured);
    supabase.rpc("get_company_member_display_names", { p_company_id: companyId }).then(({ data, error }) => {
      if (error || !data) return;
      setDisplayNames(
        new Map(
          (data as { member_id: string; display_name: string | null; full_name: string | null }[]).map((r) => [
            r.member_id,
            { display: r.display_name, full: r.full_name },
          ])
        )
      );
    });
  }, [companyId, memberId]);

  function handleServiceChange(id: string) {
    setServiceId(id);
    const svc = services.find((s) => s.id === id);
    if (svc) {
      setDuration(svc.duration_minutes);
      setPrice(Number(svc.price));
    }
  }

  // Recalcula horários disponíveis sempre que profissional/data/duração
  // mudam — só um AVISO antecipado; o banco continua sendo a autoridade
  // final contra conflito (exclusion constraint), como já era.
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
    });
    setSlots(list);
    setSlotsLoading(false);
    setTime((t) => (list.includes(t) ? t : ""));
  }, [companyId, professionalId, date, duration]);

  useEffect(() => {
    reloadSlots();
  }, [reloadSlots]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!time) {
      setError("Escolha um horário disponível.");
      return;
    }
    setSaving(true);
    setError(null);

    const scheduledStart = new Date(`${date}T${time}:00`);
    const scheduledEnd = new Date(scheduledStart.getTime() + duration * 60000);

    const supabase = createClient();
    // .select("id").single(): só seguimos (e só oferecemos o WhatsApp) quando o
    // banco CONFIRMOU a gravação e devolveu o registro.
    const { data: inserted, error } = await supabase.from("appointments").insert({
      company_id: companyId,
      client_id: clientId,
      service_id: serviceId,
      professional_member_id: professionalId,
      scheduled_start: scheduledStart.toISOString(),
      scheduled_end: scheduledEnd.toISOString(),
      price,
      notes: notes || null,
      status: "agendado",
    }).select("id").single();

    setSaving(false);
    if (error) {
      // 23P01 = violação da exclusion constraint de conflito de horário —
      // a autoridade final continua sendo o banco, mesmo com o aviso
      // antecipado da grade de horários acima.
      if (error.code === "23P01") {
        setError("Esse horário acabou de ser ocupado por outro atendimento. Escolha outro horário.");
        reloadSlots();
      } else {
        setError("Não foi possível criar o agendamento. Tente novamente.");
      }
      return;
    }

    // Agendamento salvo. Monta a confirmação; NADA é enviado: o link só abre o
    // WhatsApp com o texto pronto, e quem envia é a profissional.
    const client = clients.find((c) => c.id === clientId);
    const service = services.find((s) => s.id === serviceId);
    const prof = professionals.find((p) => p.id === professionalId);
    const names = displayNames.get(professionalId);
    const professionalName =
      resolveSignatureName({ displayName: names?.display, fullName: names?.full ?? prof?.name }) ?? null;
    // Formato escolhido pela empresa (0027): mensagens do sistema ou mensagem própria.
    // Ausente (0027 não aplicada) ou erro => mensagens do sistema, como antes.
    const { data: msgSettings } = await supabase.rpc("wa_get_message_settings", { p_company_id: companyId });
    const ms = (msgSettings ?? null) as { mode?: string; template?: string | null } | null;
    const message = buildConfirmationMessage({
      customTemplate: ms?.mode === "custom" ? ms.template ?? null : null,
      clientName: client?.name ?? "",
      startsAt: scheduledStart,
      durationMinutes: duration,
      serviceName: service?.name ?? "",
      professionalName,
      businessName: companyName,
      variantSeed: inserted.id,
    });
    // Confirmação AUTOMÁTICA (0018): o banco já decidiu na mesma transação do
    // agendamento. Se ela está na fila, o wa.me some (evita mensagem em dobro).
    // RPC ausente (0018 não aplicada) ou erro => tela como antes.
    let confirmation: ConfirmationView | null = null;
    try {
      const { data: conf, error: confError } = await supabase.rpc("wa_get_appointment_confirmation", {
        p_appointment_id: inserted.id,
      });
      if (!confError) confirmation = describeConfirmation(parseConfirmation(conf));
    } catch {
      confirmation = null;
    }
    setCreated({
      id: inserted.id,
      confirmation,
      clientId,
      clientName: client?.name ?? "",
      serviceName: service?.name ?? "",
      startsAt: scheduledStart,
      professionalName,
      whatsappUrl: whatsappChatLink(client?.phone, client?.phone_normalized, message),
      reach: whatsappReach(client?.phone, client?.phone_normalized),
    });
  }

  function closeCreated() {
    router.push("/agenda");
    router.refresh();
  }

  // Confirmação visual depois de agendar.
  if (created) {
    return (
      <div className="space-y-5 pb-4">
        <div className="flex items-center gap-2.5">
          <CheckCircle2 className="size-6 text-success" />
          <h1 className="page-title">Agendamento confirmado</h1>
        </div>

        <Card className="space-y-3">
          <div className="flex justify-between gap-4 text-sm">
            <span className="text-ink-400">Cliente</span>
            <span className="text-right font-medium text-ink-800">{created.clientName}</span>
          </div>
          <div className="flex justify-between gap-4 text-sm">
            <span className="text-ink-400">Serviço</span>
            <span className="text-right font-medium text-ink-800">{created.serviceName}</span>
          </div>
          <div className="flex justify-between gap-4 text-sm">
            <span className="text-ink-400">Data</span>
            <span className="font-medium text-ink-800">{format(created.startsAt, "dd/MM/yyyy")}</span>
          </div>
          <div className="flex justify-between gap-4 text-sm">
            <span className="text-ink-400">Horário</span>
            <span className="font-medium text-ink-800">{format(created.startsAt, "HH:mm")}</span>
          </div>
        </Card>

        <div className="space-y-2">
          {created.confirmation && (
            <Card>
              <WhatsappConfirmationStatus view={created.confirmation} />
            </Card>
          )}
          {created.confirmation && !created.confirmation.allowManual ? null : created.whatsappUrl ? (
            <>
              {/* Âncora (não window.open): o iOS não bloqueia e a profissional
                  confere a mensagem no WhatsApp antes de enviar. */}
              <a
                href={created.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded bg-ink-800 px-5 text-base font-semibold text-cream transition-colors hover:bg-ink-900"
              >
                <MessageCircle className="size-5" />
                Enviar confirmação pelo WhatsApp
              </a>
              <p className="text-center text-xs text-ink-400">
                Abre o WhatsApp com a mensagem pronta. Você revisa e decide se envia.
              </p>
            </>
          ) : (
            <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-400" />
              <span>
                {created.reach === "landline"
                  ? "O telefone cadastrado é fixo, então não dá para enviar pelo WhatsApp. "
                  : created.reach === "invalid"
                    ? "O telefone cadastrado não parece válido, então não dá para abrir o WhatsApp. "
                    : "Esta cliente não tem telefone cadastrado, então não dá para enviar pelo WhatsApp. "}
                O agendamento já está salvo.{" "}
                <Link href={`/clientes/${created.clientId}/editar`} className="font-semibold text-ink-800 underline">
                  Corrigir o telefone
                </Link>
              </span>
            </div>
          )}
          <Button variant="secondary" className="w-full" onClick={closeCreated}>
            Fechar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-4">
      <h1 className="page-title">Novo atendimento</h1>

      {hoursConfigured === false && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-ink-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Esta empresa ainda não tem horário de funcionamento cadastrado, então nenhum horário aparecerá como
            disponível. Peça para configurar o horário de funcionamento (ainda não temos uma tela para isso).
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Select label="Cliente" required value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="" disabled>
            Selecione...
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {clients.length === 0 && (
          <p className="-mt-2 text-xs text-ink-400">
            Nenhuma cliente cadastrada ainda —{" "}
            <a href="/clientes/novo" className="font-semibold text-ink-700">
              cadastre uma primeiro
            </a>
            .
          </p>
        )}

        <Select label="Serviço" required value={serviceId} onChange={(e) => handleServiceChange(e.target.value)}>
          <option value="" disabled>
            Selecione...
          </option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {formatDuration(s.duration_minutes)}
            </option>
          ))}
        </Select>
        {services.length === 0 && (
          <p className="-mt-2 text-xs text-ink-400">
            Nenhum serviço ativo —{" "}
            <a href="/mais/servicos/novo" className="font-semibold text-ink-700">
              cadastre um primeiro
            </a>
            .
          </p>
        )}

        {/* Só aparece com 2+ profissionais ativas — com uma só, não criamos
            uma etapa desnecessária no formulário. */}
        {professionals.length > 1 && (
          <Select label="Profissional" required value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
            <option value="" disabled>
              Selecione...
            </option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Input type="date" label="Data" required value={date} onChange={(e) => setDate(e.target.value)} />
          <NumberInput integer label="Duração (min)" required value={duration} onChange={setDuration} />
        </div>

        {/* Grade de horários disponíveis — o aviso antecipado que o
            briefing pediu, calculado a partir de business_hours +
            blocked_times + agendamentos existentes da profissional. */}
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700">
            <Clock className="size-3.5" />
            Horário
          </label>
          {!professionalId ? (
            <p className="text-sm text-ink-400">Escolha a profissional para ver os horários livres.</p>
          ) : slotsLoading ? (
            <p className="text-sm text-ink-400">Calculando horários livres...</p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-ink-400">
              {hoursConfigured === false
                ? "Nenhum horário de funcionamento cadastrado (veja o aviso acima)."
                : "Nenhum horário livre nesse dia. Tente outra data."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {slots.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setTime(s)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    time === s
                      ? "border-ink-800 bg-ink-800 text-cream"
                      : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-50"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        <NumberInput label="Valor (R$)" required value={price} onChange={setPrice} />

        <Textarea
          label="Observação (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" loading={saving} className="w-full">
          {saving ? "Salvando..." : "Criar agendamento"}
        </Button>
      </form>
    </div>
  );
}
