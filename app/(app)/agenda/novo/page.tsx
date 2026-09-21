"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";

type ClientOption = { id: string; name: string };
type ServiceOption = { id: string; name: string; duration_minutes: number; price: number };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function nowTimeStr() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 30)); // arredonda pra próxima meia hora
  return d.toTimeString().slice(0, 5);
}

export default function NovoAgendamentoPage() {
  const router = useRouter();
  const { companyId, memberId } = useCompany();

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);

  const [clientId, setClientId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState(nowTimeStr());
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState(0);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("clients")
      .select("id, name")
      .eq("company_id", companyId)
      .order("name")
      .then(({ data }) => setClients(data ?? []));
    supabase
      .from("services")
      .select("id, name, duration_minutes, price")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name")
      .then(({ data }) => setServices((data as ServiceOption[]) ?? []));
  }, [companyId]);

  function handleServiceChange(id: string) {
    setServiceId(id);
    const svc = services.find((s) => s.id === id);
    if (svc) {
      setDuration(svc.duration_minutes);
      setPrice(Number(svc.price));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const scheduledStart = new Date(`${date}T${time}:00`);
    const scheduledEnd = new Date(scheduledStart.getTime() + duration * 60000);

    const supabase = createClient();
    const { error } = await supabase.from("appointments").insert({
      company_id: companyId,
      client_id: clientId,
      service_id: serviceId,
      professional_member_id: memberId,
      scheduled_start: scheduledStart.toISOString(),
      scheduled_end: scheduledEnd.toISOString(),
      price,
      notes: notes || null,
      status: "agendado",
    });

    setSaving(false);
    if (error) {
      // 23P01 = violação da exclusion constraint de conflito de horário
      if (error.code === "23P01") {
        setError("Esse horário conflita com outro atendimento já agendado.");
      } else {
        setError("Não foi possível criar o agendamento. Tente novamente.");
      }
      return;
    }
    router.push("/agenda");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-charcoal-900">Novo agendamento</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Cliente</label>
          <select
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          >
            <option value="" disabled>Selecione...</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {clients.length === 0 && (
            <p className="mt-1 text-xs text-charcoal-500">
              Nenhuma cliente cadastrada ainda —{" "}
              <a href="/clientes/novo" className="font-semibold text-plum-500">cadastre uma primeiro</a>.
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Serviço</label>
          <select
            required
            value={serviceId}
            onChange={(e) => handleServiceChange(e.target.value)}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          >
            <option value="" disabled>Selecione...</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {services.length === 0 && (
            <p className="mt-1 text-xs text-charcoal-500">
              Nenhum serviço ativo —{" "}
              <a href="/mais/servicos/novo" className="font-semibold text-plum-500">cadastre um primeiro</a>.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-charcoal-700">Data</label>
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-charcoal-700">Horário</label>
            <input
              type="time"
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-charcoal-700">Duração (min)</label>
            <input
              type="number"
              required
              min={5}
              step={5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-charcoal-700">Valor (R$)</label>
            <input
              type="number"
              required
              min={0}
              step={0.01}
              value={price}
              onChange={(e) => setPrice(Number(e.target.value))}
              className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Observação (opcional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-60"
        >
          {saving ? "Salvando..." : "Criar agendamento"}
        </button>
      </form>
    </div>
  );
}
