// push-appointment-alerts — avisos no celular da profissional (Web Push). Roda a cada minuto pelo pg_cron
// (segredo do Vault em x-cron-secret) e faz duas coisas:
//   1) Aviso antes de cada atendimento (0048): push_claim_due_alerts reserva e devolve o que chegou na hora.
//   2) Aviso semanal de clientes sumidas (0049): às segundas, push_claim_weekly_overdue devolve quem deve
//      receber; a função conta as sumidas da empresa (mesma regra de lib/hive/relationship.ts) e envia se
//      houver pelo menos uma. Aparelho que o serviço de push recusa (404/410) é removido.
// Segredos: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e, se quiser, VAPID_SUBJECT. Publicar SEM JWT (acesso pelo
// segredo do cron). Teste manual do aviso de sumidas: corpo {"forceOverdueMember":"<id do membro>"}.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
// A Apple exige um contato válido (mailto: ou https:) no token VAPID.
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "https://socia-beauty.lovable.app";
const TIME_ZONE = "America/Sao_Paulo";
const PAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "push-appointment-alerts", ...o }));

type Sub = { id: string; endpoint: string; p256dh: string; auth_key: string };
type Alert = {
  alert_appointment_id: string; alert_start: string; alert_minutes: number;
  client_name: string; service_name: string; subs: Sub[] | null;
};
type Recipient = { out_member_id: string; out_company_id: string; subs: Sub[] | null };
type Payload = { title: string; body: string; url: string; tag: string };

// --- IGUAL a minutesLabel de lib/hive/push-alerts.ts (o teste compara os dois) ---------------
export function minutesLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
// ----------------------------------------------------------------------------------------------

// --- IGUAL a overdueNotification de lib/hive/push-alerts.ts (o teste compara os dois) -----------
export function overdueNotification(count: number) {
  const one = count === 1;
  return {
    title: one ? "1 cliente sumida" : `${count} clientes sumidas`,
    body: one
      ? "Dê uma olhada na lista e entre em contato com ela."
      : "Dê uma olhada na lista e entre em contato com elas.",
    url: "/clientes?segmento=sumidas",
    tag: "overdue-clients",
  };
}
// -------------------------------------------------------------------------------------------------

// --- IGUAL à regra "sumida" de computeClientRelationship (lib/hive/relationship.ts; o teste compara) ---
// Com 2+ visitas: passou de 1,5x o intervalo médio dela. Com 0 ou 1 visita: mais de 60 dias. Sem visita: não.
export function isOverdueClient(visitDates: string[], nowMs: number): boolean {
  const t = visitDates.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  if (t.length === 0) return false;
  const DAY = 86400000;
  const daysSince = Math.floor((nowMs - t[t.length - 1]) / DAY);
  if (t.length < 2) return daysSince > 60;
  let sum = 0;
  for (let i = 1; i < t.length; i++) sum += (t[i] - t[i - 1]) / DAY;
  const avg = Math.round(sum / (t.length - 1));
  return daysSince > avg * 1.5;
}
// -------------------------------------------------------------------------------------------------------

const clock = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });

/** Texto do aviso antes do atendimento: "Daqui a 30 min: Ana" / "Gel nas mãos às 14:30". */
export function buildPayload(a: Alert): Payload {
  return {
    title: `Daqui a ${minutesLabel(a.alert_minutes)}: ${a.client_name}`,
    body: `${a.service_name} às ${clock.format(new Date(a.alert_start))}`,
    url: "/agenda",
    tag: `appt-${a.alert_appointment_id}`,
  };
}

// Lê todas as linhas de uma consulta paginada (o PostgREST devolve no máximo 1000 por vez).
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) return all;
  }
}

/** Quantas clientes ATIVAS da empresa estão sumidas (mesma lista da aba "Sumidas" em Clientes). */
async function countOverdue(companyId: string): Promise<number> {
  const clients = await fetchAll<{ id: string }>((a, b) =>
    admin.from("clients").select("id").eq("company_id", companyId).is("archived_at", null).order("id").range(a, b));
  const active = new Set(clients.map((c) => c.id));
  const visits = await fetchAll<{ client_id: string; scheduled_start: string }>((a, b) =>
    admin.from("appointments").select("client_id, scheduled_start").eq("company_id", companyId).eq("status", "concluido").order("id").range(a, b));
  const byClient = new Map<string, string[]>();
  for (const v of visits) {
    if (!active.has(v.client_id)) continue;
    const list = byClient.get(v.client_id);
    if (list) list.push(v.scheduled_start);
    else byClient.set(v.client_id, [v.scheduled_start]);
  }
  const now = Date.now();
  let n = 0;
  for (const dates of byClient.values()) if (isOverdueClient(dates, now)) n++;
  return n;
}

type Stats = { sent: number; failed: number; dropped: number };

async function pushTo(subs: Sub[], payload: Payload, ttl: number, stats: Stats, dead: string[], ctx: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, body, { TTL: ttl, urgency: "high" });
      stats.sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { dead.push(s.id); stats.dropped++; }
      else { stats.failed++; log({ ...ctx, subscriptionId: s.id, status: code ?? null }); }
    }
  }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Método não permitido.", { status: 405 });
  const { data: okSecret } = await admin.rpc("push_cron_secret_ok", { p_secret: req.headers.get("x-cron-secret") ?? "" });
  if (okSecret !== true) return new Response("Não autorizado.", { status: 401 });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    log({ error: "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ausentes" });
    return new Response(JSON.stringify({ error: "chaves VAPID ausentes" }), { status: 500 });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const input = await req.json().catch(() => ({})) as { forceOverdueMember?: unknown };
  const force = typeof input.forceOverdueMember === "string" && UUID.test(input.forceOverdueMember) ? input.forceOverdueMember : null;

  const dead: string[] = [];

  // 1) Aviso antes do atendimento
  const { data, error } = await admin.rpc("push_claim_due_alerts");
  if (error) {
    log({ error: error.message });
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  const alerts = (data as Alert[]) ?? [];
  const appt = { alerts: alerts.length, sent: 0, failed: 0, dropped: 0 };
  for (const a of alerts) {
    // O aviso perde a validade quando o atendimento começa.
    const ttl = Math.max(60, Math.floor((Date.parse(a.alert_start) - Date.now()) / 1000));
    await pushTo(a.subs ?? [], buildPayload(a), ttl, appt, dead, { appointmentId: a.alert_appointment_id });
  }

  // 2) Aviso semanal de clientes sumidas (um erro aqui não derruba o aviso de atendimento)
  const overdue = { members: 0, sent: 0, failed: 0, dropped: 0, none: 0, error: false };
  try {
    const { data: recips, error: e2 } = await admin.rpc("push_claim_weekly_overdue", { p_force_member: force });
    if (e2) throw new Error(e2.message);
    const list = (recips as Recipient[]) ?? [];
    overdue.members = list.length;
    const counts = new Map<string, number>();
    for (const r of list) {
      if (!counts.has(r.out_company_id)) counts.set(r.out_company_id, await countOverdue(r.out_company_id));
      const n = counts.get(r.out_company_id)!;
      if (n === 0) { overdue.none++; continue; }
      await pushTo(r.subs ?? [], overdueNotification(n), 12 * 3600, overdue, dead, { memberId: r.out_member_id, kind: "overdue" });
    }
  } catch (e) {
    overdue.error = true;
    log({ kind: "overdue", error: (e as Error).message });
  }

  if (dead.length) await admin.rpc("push_drop_subscriptions", { p_ids: dead });
  if (appt.alerts || overdue.members) log({ ...appt, overdue });
  return new Response(JSON.stringify({ ...appt, overdue }), { status: 200, headers: { "Content-Type": "application/json" } });
});
