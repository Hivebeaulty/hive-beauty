// push-appointment-alerts — avisa a profissional no celular antes de cada atendimento (0048).
//
// A cada minuto o pg_cron chama esta função (segredo do Vault em x-cron-secret). Ela pede ao banco
// os avisos que chegaram na hora (push_claim_due_alerts: reserva e devolve, sem repetir) e envia
// um Web Push para cada aparelho inscrito da profissional. Aparelho que o serviço de push recusa
// (404/410) é removido. Segredos: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e, se quiser, VAPID_SUBJECT.
// Publicar SEM JWT (o acesso é pelo segredo do cron).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
// A Apple exige um contato válido (mailto: ou https:) no token VAPID.
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "https://socia-beauty.lovable.app";
const TIME_ZONE = "America/Sao_Paulo";

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "push-appointment-alerts", ...o }));

type Sub = { id: string; endpoint: string; p256dh: string; auth_key: string };
type Alert = {
  alert_appointment_id: string; alert_start: string; alert_minutes: number;
  client_name: string; service_name: string; subs: Sub[] | null;
};

// --- IGUAL a minutesLabel de lib/hive/push-alerts.ts (o teste compara os dois) ---------------
export function minutesLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
// ----------------------------------------------------------------------------------------------

const clock = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });

/** Texto da notificação: "Daqui a 30 min: Ana" / "Gel nas mãos às 14:30". */
export function buildPayload(a: Alert) {
  return {
    title: `Daqui a ${minutesLabel(a.alert_minutes)}: ${a.client_name}`,
    body: `${a.service_name} às ${clock.format(new Date(a.alert_start))}`,
    url: "/agenda",
    tag: `appt-${a.alert_appointment_id}`,
  };
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

  const { data, error } = await admin.rpc("push_claim_due_alerts");
  if (error) {
    log({ error: error.message });
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  const alerts = ((data as Alert[]) ?? []);
  const summary = { alerts: alerts.length, sent: 0, failed: 0, dropped: 0 };
  const dead: string[] = [];

  for (const a of alerts) {
    const payload = JSON.stringify(buildPayload(a));
    // O aviso perde a validade quando o atendimento começa.
    const ttl = Math.max(60, Math.floor((Date.parse(a.alert_start) - Date.now()) / 1000));
    await Promise.all((a.subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
          { TTL: ttl, urgency: "high" },
        );
        summary.sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { dead.push(s.id); summary.dropped++; }
        else { summary.failed++; log({ appointmentId: a.alert_appointment_id, subscriptionId: s.id, status: code ?? null }); }
      }
    }));
  }
  if (dead.length) await admin.rpc("push_drop_subscriptions", { p_ids: dead });
  if (alerts.length) log(summary);
  return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
});
