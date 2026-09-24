"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { getActiveProfessionals, getAvailableSlots, hasAnyBusinessHours, type Professional } from "@/lib/hive/schedule";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Clock, AlertTriangle } from "lucide-react";

type ClientOption = { id: string; name: string };
type ServiceOption = { id: string; name: string; duration_minutes: number; price: number };

export default function NovoAgendamentoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { companyId, memberId } = useCompany();

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);

  const [clientId, setClientId] = useState("");
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

  // Dados de apoio — clientes, serviços ativos e profissionais ativas.
  useEffect(() => {
    const supabase = createClient();
    supabase.from("clients").select("id, name").eq("company_id", companyId).order("name").then(({ data }) => setClients(data ?? []));
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
    const { error } = await supabase.from("appointments").insert({
      company_id: companyId,
      client_id: clientId,
      service_id: serviceId,
      professional_member_id: professionalId,
      scheduled_start: scheduledStart.toISOString(),
      scheduled_end: scheduledEnd.toISOString(),
      price,
      notes: notes || null,
      status: "agendado",
    });

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
    router.push("/agenda");
    router.refresh();
  }

  return (
    <div className="space-y-5 pb-4">
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Novo atendimento</h1>

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
              {s.name} · {s.duration_minutes}min
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
          <Input
            type="number"
            label="Duração (min)"
            required
            min={5}
            step={5}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
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

        <Input
          type="number"
          label="Valor (R$)"
          required
          min={0}
          step={0.01}
          value={price}
          onChange={(e) => setPrice(Number(e.target.value))}
        />

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
