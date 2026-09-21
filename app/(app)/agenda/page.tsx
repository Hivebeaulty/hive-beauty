"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { STATUS_LABEL, STATUS_COLOR } from "@/lib/hive/status";

type Appointment = {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  price: number;
  clients: { name: string } | null;
  services: { name: string } | null;
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDayLabel(d: Date) {
  const today = startOfDay(new Date());
  const target = startOfDay(d);
  if (target.getTime() === today.getTime()) return "Hoje";
  if (target.getTime() === addDays(today, 1).getTime()) return "Amanhã";
  if (target.getTime() === addDays(today, -1).getTime()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
}

export default function AgendaPage() {
  const { companyId } = useCompany();
  const [date, setDate] = useState(() => startOfDay(new Date()));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const dayStart = startOfDay(date);
    const dayEnd = addDays(dayStart, 1);

    const { data } = await supabase
      .from("appointments")
      .select("id, scheduled_start, scheduled_end, status, price, clients(name), services(name)")
      .eq("company_id", companyId)
      .gte("scheduled_start", dayStart.toISOString())
      .lt("scheduled_start", dayEnd.toISOString())
      .order("scheduled_start");

    setAppointments((data as unknown as Appointment[]) ?? []);
    setLoading(false);
  }, [companyId, date]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">Agenda</h1>
        <Link href="/agenda/novo" className="rounded-xl bg-plum-500 px-4 py-2 text-sm font-semibold text-white">
          + Novo
        </Link>
      </div>

      <div className="flex items-center justify-between rounded-2xl bg-white p-2 shadow-sm">
        <button
          onClick={() => setDate((d) => addDays(d, -1))}
          className="rounded-xl px-3 py-2 text-charcoal-700 hover:bg-blush-50"
          aria-label="Dia anterior"
        >
          ‹
        </button>
        <button onClick={() => setDate(startOfDay(new Date()))} className="text-sm font-semibold text-charcoal-900">
          {fmtDayLabel(date)}
        </button>
        <button
          onClick={() => setDate((d) => addDays(d, 1))}
          className="rounded-xl px-3 py-2 text-charcoal-700 hover:bg-blush-50"
          aria-label="Próximo dia"
        >
          ›
        </button>
      </div>

      {loading && <p className="text-center text-sm text-charcoal-500">Carregando...</p>}

      {!loading && appointments.length === 0 && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="mb-4 text-charcoal-700">Nenhum atendimento neste dia.</p>
          <Link href="/agenda/novo" className="font-semibold text-plum-500">
            Criar agendamento
          </Link>
        </div>
      )}

      <div className="space-y-2">
        {appointments.map((a) => (
          <Link key={a.id} href={`/agenda/${a.id}`} className="flex gap-3 rounded-2xl bg-white p-4 shadow-sm">
            <div className="w-14 shrink-0 text-sm font-semibold text-plum-500">
              {new Date(a.scheduled_start).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div className="flex-1">
              <p className="font-semibold text-charcoal-900">{a.clients?.name}</p>
              <p className="text-xs text-charcoal-500">{a.services?.name}</p>
            </div>
            <span className={`h-fit self-center rounded-full px-2 py-1 text-[10px] font-semibold ${STATUS_COLOR[a.status]}`}>
              {STATUS_LABEL[a.status]}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
