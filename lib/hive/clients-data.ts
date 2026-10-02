// Carrega as clientes de uma empresa já com os dados de relacionamento
// (frequência, aniversário, segmentos). Usado pela lista de Clientes e pela
// Central de comunicação, para os dois sempre contarem a mesma coisa.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeClientRelationship,
  classifySegments,
  daysUntilNextBirthday,
  type ClientSegment,
} from "./relationship";
import type { CommStatus } from "./communication";

export type ClientRow = {
  id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  last_visit_at: string | null;
  birth_date: string | null;
  archived_at: string | null;
  comm_status: CommStatus;
  count: number;
  isOverdue: boolean;
  daysToBirthday: number | null;
  segments: ClientSegment[];
};

type RawClient = Omit<ClientRow, "count" | "isOverdue" | "daysToBirthday" | "segments">;

export async function loadClientRows(
  supabase: SupabaseClient,
  companyId: string
): Promise<{ rows: ClientRow[]; failed: boolean }> {
  const [clientsRes, apptsRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, phone, phone_normalized, last_visit_at, birth_date, archived_at, comm_status")
      .eq("company_id", companyId)
      .order("name"),
    // Só client_id + data: o suficiente para calcular a frequência de cada
    // cliente sem trazer o histórico inteiro.
    supabase
      .from("appointments")
      .select("client_id, scheduled_start")
      .eq("company_id", companyId)
      .eq("status", "concluido"),
  ]);

  if (clientsRes.error || apptsRes.error) return { rows: [], failed: true };

  const visitsByClient = new Map<string, string[]>();
  for (const a of apptsRes.data ?? []) {
    const list = visitsByClient.get(a.client_id);
    if (list) list.push(a.scheduled_start);
    else visitsByClient.set(a.client_id, [a.scheduled_start]);
  }

  const rows = ((clientsRes.data ?? []) as RawClient[]).map((c) => {
    const rel = computeClientRelationship(visitsByClient.get(c.id) ?? []);
    const daysToBirthday = daysUntilNextBirthday(c.birth_date);
    return {
      ...c,
      count: rel.visitCount,
      isOverdue: rel.isOverdue,
      daysToBirthday,
      segments: classifySegments(rel, daysToBirthday),
    };
  });

  return { rows, failed: false };
}
