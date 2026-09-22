import type { SupabaseClient } from "@supabase/supabase-js";
import { startOfWeek, addDays as addDaysFns, startOfMonth, format } from "date-fns";

export type Professional = { id: string; name: string; role: string };

// Lê company_members (visível a toda a equipe) + os nomes via RPC
// security-definer (ver migration 0005 — profiles não é aberta à equipe).
export async function getActiveProfessionals(
  supabase: SupabaseClient,
  companyId: string
): Promise<Professional[]> {
  const [{ data: members }, { data: names }] = await Promise.all([
    supabase.from("company_members").select("id, role, active").eq("company_id", companyId).eq("active", true),
    supabase.rpc("get_company_member_names", { p_company_id: companyId }),
  ]);

  const nameById = new Map<string, string>(
    ((names as { member_id: string; full_name: string }[]) ?? []).map((n) => [n.member_id, n.full_name])
  );

  return ((members as { id: string; role: string }[]) ?? [])
    .map((m) => ({ id: m.id, role: m.role, name: nameById.get(m.id) ?? "Profissional" }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

// ---------------------------------------------------------------------------
// Horários disponíveis — só um AVISO ANTECIPADO pra usuária. A autoridade
// final continua sendo a exclusion constraint no banco (no_overlap_per_professional);
// se duas pessoas tentarem o mesmo horário ao mesmo tempo, o banco decide.
// ---------------------------------------------------------------------------
const SLOT_STEP_MINUTES = 15;

function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(min: number) {
  const h = Math.floor(min / 60)
    .toString()
    .padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

export async function getAvailableSlots(params: {
  supabase: SupabaseClient;
  companyId: string;
  professionalId: string;
  dateStr: string; // yyyy-MM-dd
  durationMinutes: number;
  excludeAppointmentId?: string;
}): Promise<string[]> {
  const { supabase, companyId, professionalId, dateStr, durationMinutes, excludeAppointmentId } = params;
  const weekday = new Date(`${dateStr}T00:00:00`).getDay();
  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd = new Date(`${dateStr}T23:59:59`);

  const [{ data: hours }, { data: blocks }, { data: appts }] = await Promise.all([
    supabase
      .from("business_hours")
      .select("professional_member_id, start_time, end_time")
      .eq("company_id", companyId)
      .eq("weekday", weekday)
      .or(`professional_member_id.eq.${professionalId},professional_member_id.is.null`),
    supabase
      .from("blocked_times")
      .select("start_at, end_at, professional_member_id")
      .eq("company_id", companyId)
      .lt("start_at", dayEnd.toISOString())
      .gt("end_at", dayStart.toISOString())
      .or(`professional_member_id.eq.${professionalId},professional_member_id.is.null`),
    supabase
      .from("appointments")
      .select("id, scheduled_start, scheduled_end, status")
      .eq("company_id", companyId)
      .eq("professional_member_id", professionalId)
      .gte("scheduled_start", dayStart.toISOString())
      .lt("scheduled_start", dayEnd.toISOString())
      .not("status", "in", "(cancelado,nao_compareceu)"),
  ]);

  type HourRow = { professional_member_id: string | null; start_time: string; end_time: string };
  const hourRows = (hours as HourRow[]) ?? [];
  // Override da profissional tem prioridade sobre o horário padrão da empresa.
  const ownRows = hourRows.filter((h) => h.professional_member_id === professionalId);
  const windows = (ownRows.length > 0 ? ownRows : hourRows.filter((h) => h.professional_member_id === null)).map(
    (h) => ({ start: timeToMinutes(h.start_time.slice(0, 5)), end: timeToMinutes(h.end_time.slice(0, 5)) })
  );
  if (windows.length === 0) return [];

  const busyRanges = [
    ...(((blocks as { start_at: string; end_at: string }[]) ?? []).map((b) => ({
      start: new Date(b.start_at),
      end: new Date(b.end_at),
    }))),
    ...(((appts as { id: string; scheduled_start: string; scheduled_end: string }[]) ?? [])
      .filter((a) => a.id !== excludeAppointmentId)
      .map((a) => ({ start: new Date(a.scheduled_start), end: new Date(a.scheduled_end) }))),
  ];

  const slots: string[] = [];
  const now = new Date();
  const isToday = dateStr === format(now, "yyyy-MM-dd");

  for (const w of windows) {
    for (let start = w.start; start + durationMinutes <= w.end; start += SLOT_STEP_MINUTES) {
      const slotStart = new Date(`${dateStr}T${minutesToTime(start)}:00`);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);
      if (isToday && slotStart < now) continue;
      const overlaps = busyRanges.some((b) => slotStart < b.end && slotEnd > b.start);
      if (!overlaps) slots.push(minutesToTime(start));
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Grades de calendário (semana / mês) — só geometria de datas, sem I/O.
// ---------------------------------------------------------------------------
export function getWeekDays(reference: Date): Date[] {
  const start = startOfWeek(reference, { weekStartsOn: 1 });
  return Array.from({ length: 7 }, (_, i) => addDaysFns(start, i));
}

// Grade de 6 semanas (42 dias) começando na segunda-feira antes do dia 1,
// incluindo dias do mês anterior/seguinte pra preencher a grade.
export function getMonthGrid(reference: Date): Date[] {
  const firstOfMonth = startOfMonth(reference);
  const start = startOfWeek(firstOfMonth, { weekStartsOn: 1 });
  return Array.from({ length: 42 }, (_, i) => addDaysFns(start, i));
}

export function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function isSameMonth(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
