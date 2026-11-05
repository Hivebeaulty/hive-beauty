// Aviso no celular antes do atendimento (0048): opções, textos e utilidades puras.
// Sem imports de pacotes: o teste (tests/load-ts.cjs) carrega este arquivo direto.

export const ALERT_OPTIONS = [
  { value: 15, label: "15 minutos antes" },
  { value: 30, label: "30 minutos antes" },
  { value: 60, label: "1 hora antes" },
  { value: 120, label: "2 horas antes" },
] as const;

/** Antecedência usada quando a profissional ativa os avisos pela primeira vez. */
export const DEFAULT_ALERT_MINUTES = 30;
export const ALERT_MIN_MINUTES = 5;
export const ALERT_MAX_MINUTES = 1440;

export function isValidAlertMinutes(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= ALERT_MIN_MINUTES && v <= ALERT_MAX_MINUTES;
}

// --- IGUAL a minutesLabel de supabase/functions/push-appointment-alerts/index.ts (o teste compara) ---
export function minutesLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
// ---------------------------------------------------------------------------------------------------

/** Chave VAPID pública (base64url) no formato que o navegador pede para se inscrever. */
export function urlBase64ToUint8Array(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// --- IGUAIS a overdueNotification de supabase/functions/push-appointment-alerts/index.ts (o teste compara) ---
/** Aviso semanal de clientes sumidas: quantas são e o que fazer. */
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
// -------------------------------------------------------------------------------------------------------------
