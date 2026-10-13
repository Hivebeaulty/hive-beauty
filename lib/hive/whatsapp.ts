// WhatsApp (W3) — lógica PURA da tela Mais → Configurações → WhatsApp.
// Nada aqui é segurança: quem decide quem conecta, vê o QR ou desconecta são as
// RPCs da migration 0017 (wa_get_status / wa_request_connection / wa_get_qr /
// wa_disconnect). Isto só traduz o que o banco devolveu em texto, cor e ação,
// e decide o ritmo de atualização da tela.
import { formatBrazilPhone } from "./phone";

export type WaStatus =
  | "disconnected"
  | "connect_requested"
  | "qr_pending"
  | "connecting"
  | "connected"
  | "disconnect_requested"
  | "logged_out"
  | "error"
  | "stale";

const KNOWN: readonly WaStatus[] = [
  "disconnected",
  "connect_requested",
  "qr_pending",
  "connecting",
  "connected",
  "disconnect_requested",
  "logged_out",
  "error",
  "stale",
];

export type WaStatusSnapshot = {
  status: WaStatus;
  phone: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  canManage: boolean;
  canSend: boolean;
  qrAvailable: boolean;
};

// Lê a resposta (jsonb) de wa_get_status. Qualquer coisa inesperada vira null —
// a tela mostra "não foi possível consultar", nunca um estado inventado.
export function parseStatus(data: unknown): WaStatusSnapshot | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.status !== "string" || !KNOWN.includes(d.status as WaStatus)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    status: d.status as WaStatus,
    phone: str(d.phone),
    connectedAt: str(d.connected_at),
    lastSeenAt: str(d.last_seen_at),
    lastError: str(d.last_error),
    canManage: d.can_manage === true,
    canSend: d.can_send === true,
    qrAvailable: d.qr_available === true,
  };
}

export type WaQr = { value: string; expiresAt: string };

export function parseQr(data: unknown): WaQr | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.qr !== "string" || d.qr.length < 10 || typeof d.expires_at !== "string") return null;
  if (Number.isNaN(Date.parse(d.expires_at))) return null;
  return { value: d.qr, expiresAt: d.expires_at };
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "gold";

export type StatusView = {
  label: string;
  tone: Tone;
  description: string;
  busy: boolean; // algo está em andamento (mostrar indicador, atualizar rápido)
};

// Texto de cada estado, do ponto de vista de quem usa.
export function describeStatus(
  s: WaStatus,
  opts: { lastError?: string | null; workerSlow?: boolean; canManage?: boolean } = {}
): StatusView {
  switch (s) {
    case "connected":
      return { label: "Conectado", tone: "success", busy: false, description: "O WhatsApp da empresa está conectado à Áurea." };
    case "connect_requested":
      return {
        label: "Preparando conexão",
        tone: "gold",
        busy: true,
        description: opts.workerSlow
          ? "O serviço de conexão ainda não respondeu. Ele pode estar fora do ar; tente de novo em alguns minutos."
          : "Gerando o QR Code. Isso leva alguns segundos.",
      };
    case "qr_pending":
      return {
        label: "Aguardando leitura do QR",
        tone: "gold",
        busy: true,
        description: opts.canManage === false
          ? "A administração da empresa está conectando o WhatsApp."
          : "Use o código abaixo no celular da empresa. Ele é renovado sozinho até ser lido.",
      };
    case "connecting":
      return { label: "Conectando", tone: "warning", busy: true, description: "Estabelecendo a conexão com o WhatsApp." };
    case "disconnect_requested":
      return { label: "Desconectando", tone: "neutral", busy: true, description: "Desvinculando o aparelho." };
    case "logged_out":
      return {
        label: "Desconectado pelo celular",
        tone: "warning",
        busy: false,
        description: "O aparelho foi desvinculado no celular. Conecte de novo para voltar a usar.",
      };
    case "error":
      return {
        label: "Erro na conexão",
        tone: "danger",
        busy: false,
        description: opts.lastError ? `${opts.lastError} Conecte de novo para tentar outra vez.` : "A conexão foi interrompida. Conecte de novo para tentar outra vez.",
      };
    case "stale":
      return {
        label: "Sem sinal",
        tone: "danger",
        busy: false,
        description: "O serviço que mantém o WhatsApp conectado não responde há alguns minutos. Enquanto isso, as confirmações abrem o WhatsApp no seu celular.",
      };
    case "disconnected":
    default:
      return {
        label: "Desconectado",
        tone: "neutral",
        busy: false,
        description: "Enquanto não estiver conectado, as confirmações abrem o WhatsApp no seu celular.",
      };
  }
}

export const isManagerRole = (role: string | null | undefined) => role === "owner" || role === "admin";

// Quais ações a tela oferece. canManage vem do BANCO (wa_get_status); o papel
// local só reforça (se divergirem, vale o mais restritivo).
export function availableActions(s: WaStatus, canManage: boolean, role?: string | null) {
  const manage = canManage && (role === undefined || isManagerRole(role));
  return {
    connect: manage && ["disconnected", "logged_out", "error", "stale"].includes(s),
    disconnect: manage && ["connected", "connecting", "qr_pending", "connect_requested", "stale", "error"].includes(s),
    showQr: manage && s === "qr_pending",
  };
}

// Ritmo de atualização: rápido enquanto algo acontece, lento quando estável,
// recuo crescente quando a consulta falha. Aba escondida: pausa (null).
export function nextPollMs(s: WaStatus | null, o: { visible: boolean; failures: number }): number | null {
  if (!o.visible) return null;
  if (o.failures > 0) return Math.min(60000, 5000 * 2 ** (o.failures - 1));
  if (s === null) return 5000;
  if (["connect_requested", "qr_pending", "connecting", "disconnect_requested"].includes(s)) return 2000;
  return 15000;
}

export const QR_MAX_MS = 60000;

// Até quando o QR vale NESTA tela. O banco só devolve QR válido e informa a
// validade; o relógio do aparelho pode estar adiantado/atrasado, então a conta
// é feita a partir do momento em que a tela RECEBEU o QR, limitada a 60 s.
export function qrLocalDeadline(expiresAt: string, receivedAt: number, nowAtReceipt: number = receivedAt): number {
  const remaining = Date.parse(expiresAt) - nowAtReceipt;
  const clamped = Math.max(5000, Math.min(QR_MAX_MS, Number.isFinite(remaining) ? remaining : QR_MAX_MS));
  return receivedAt + clamped;
}

export function qrSecondsLeft(deadline: number | null, now: number): number {
  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

// "Preparando conexão" por mais de 45 s sem QR = o serviço provavelmente está fora.
export const WORKER_SLOW_MS = 45000;
export function isWorkerSlow(s: WaStatus | null, waitingSince: number | null, now: number): boolean {
  return s === "connect_requested" && waitingSince !== null && now - waitingSince > WORKER_SLOW_MS;
}

export type RpcErrorKind = "unavailable" | "forbidden" | "session" | "network" | "unknown";

// Classifica o erro de uma RPC do Supabase. "unavailable" = a integração ainda
// não existe neste banco (0017 não aplicada) ou a empresa não foi encontrada.
export function classifyRpcError(err: { code?: string | null; message?: string | null } | null | undefined): RpcErrorKind {
  const code = err?.code ?? "";
  const msg = (err?.message ?? "").toLowerCase();
  if (code === "PGRST202" || code === "42883" || code === "P0002") return "unavailable";
  if (code === "42501") return "forbidden";
  if (code === "28000" || code === "PGRST301" || code === "PGRST303") return "session";
  if (!code && (msg.includes("fetch") || msg.includes("network") || msg.includes("timeout") || msg.includes("failed"))) return "network";
  return "unknown";
}

export function rpcErrorMessage(kind: RpcErrorKind): string {
  switch (kind) {
    case "unavailable":
      return "A integração com o WhatsApp ainda não está disponível neste ambiente.";
    case "forbidden":
      return "Só a administração da empresa pode fazer isso.";
    case "session":
      return "Sua sessão expirou. Entre novamente.";
    case "network":
      return "Sem conexão com o servidor. Tentando de novo…";
    default:
      return "Não foi possível consultar o WhatsApp agora. Tentando de novo…";
  }
}

export function formatConnectedPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.startsWith("55") && (phone.length === 12 || phone.length === 13) ? formatBrazilPhone(phone) : `+${phone}`;
}
