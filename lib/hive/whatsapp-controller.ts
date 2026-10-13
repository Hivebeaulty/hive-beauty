// Controlador da tela de WhatsApp (W3), sem React: decide QUANDO consultar o
// banco e o que mostrar. Testável no Node com relógio falso.
//
// Regras:
//  - Nunca anuncia sucesso que o banco não confirmou: "Conectado" só aparece
//    quando wa_get_status devolve 'connected'. Pedir conexão/desconexão mostra
//    "pedido enviado" e a tela segue o que o banco disser.
//  - Falha de consulta não trava a tela: mantém o último estado conhecido,
//    avisa que ele pode estar desatualizado e tenta de novo com espera crescente.
//  - O QR só é buscado por quem o banco diz que pode gerir (can_manage) e some
//    da tela quando vence (no máximo 60 s depois de recebido).
//  - Aba escondida: para de consultar; ao voltar, consulta na hora.
import {
  availableActions,
  classifyRpcError,
  isWorkerSlow,
  nextPollMs,
  parseQr,
  parseStatus,
  qrLocalDeadline,
  rpcErrorMessage,
  WORKER_SLOW_MS,
  type RpcErrorKind,
  type WaStatusSnapshot,
} from "./whatsapp";

export type RpcError = { code?: string | null; message?: string | null } | null | undefined;
export type RpcResult = { data?: unknown; error?: RpcError };

export interface WaApi {
  getStatus(): Promise<RpcResult>;
  getQr(): Promise<RpcResult>;
  requestConnection(): Promise<RpcResult>;
  disconnect(): Promise<RpcResult>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type WaPhase = "loading" | "ready" | "unavailable" | "session" | "error";

export type WaViewState = {
  phase: WaPhase;
  snapshot: WaStatusSnapshot | null;
  refreshError: string | null; // a última consulta falhou: o que está na tela pode estar desatualizado
  failures: number;
  qr: { value: string; deadline: number } | null;
  waitingSince: number | null;
  workerSlow: boolean;
  pending: null | "connect" | "disconnect";
  actionError: string | null;
  notice: string | null;
};

export const initialState: WaViewState = {
  phase: "loading",
  snapshot: null,
  refreshError: null,
  failures: 0,
  qr: null,
  waitingSince: null,
  workerSlow: false,
  pending: null,
  actionError: null,
  notice: null,
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class WhatsappController {
  state: WaViewState = initialState;
  private api: WaApi;
  private clock: Clock;
  private role: string | null | undefined;
  private onChange: (s: WaViewState) => void;
  private visible = true;
  private stopped = true;
  private pollTimer: unknown = null;
  private qrTimer: unknown = null;
  private slowTimer: unknown = null;
  private seq = 0;
  private inFlight: Promise<void> | null = null;

  constructor(api: WaApi, opts: { onChange: (s: WaViewState) => void; clock?: Clock; role?: string | null }) {
    this.api = api;
    this.clock = opts.clock ?? realClock;
    this.role = opts.role;
    this.onChange = opts.onChange;
  }

  private set(patch: Partial<WaViewState>) {
    this.state = { ...this.state, ...patch };
    if (!this.stopped) this.onChange(this.state);
  }

  start() {
    this.stopped = false;
    this.onChange(this.state);
    void this.refresh();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
  }

  private clearTimers() {
    if (this.pollTimer) this.clock.clearTimeout(this.pollTimer);
    if (this.qrTimer) this.clock.clearTimeout(this.qrTimer);
    if (this.slowTimer) this.clock.clearTimeout(this.slowTimer);
    this.pollTimer = this.qrTimer = this.slowTimer = null;
  }

  setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      if (this.pollTimer) this.clock.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    } else if (!this.stopped) {
      void this.refresh();
    }
  }

  private schedule() {
    if (this.stopped) return;
    if (this.pollTimer) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.state.phase === "unavailable" || this.state.phase === "session") return; // não adianta insistir
    const ms = nextPollMs(this.state.snapshot?.status ?? null, { visible: this.visible, failures: this.state.failures });
    if (ms === null) return;
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      void this.refresh();
    }, ms);
  }

  // Consulta o status (uma de cada vez; respostas antigas são descartadas).
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const mySeq = ++this.seq;
    this.inFlight = (async () => {
      let res: RpcResult;
      try {
        res = await this.api.getStatus();
      } catch (e) {
        res = { error: { message: e instanceof Error ? e.message : "failed to fetch" } };
      }
      if (this.stopped || mySeq !== this.seq) return;
      const snapshot = res.error ? null : parseStatus(res.data);
      if (!snapshot) {
        this.onFailure(res.error ? classifyRpcError(res.error) : "unknown");
        return;
      }
      this.onSnapshot(snapshot);
      if (availableActions(snapshot.status, snapshot.canManage, this.role).showQr) await this.fetchQr();
      else if (this.state.qr) this.set({ qr: null });
    })().finally(() => {
      if (mySeq === this.seq) this.inFlight = null;
      this.schedule();
    });
    return this.inFlight;
  }

  private onFailure(kind: RpcErrorKind) {
    const failures = this.state.failures + 1;
    if (kind === "unavailable") {
      this.set({ phase: "unavailable", failures, refreshError: rpcErrorMessage(kind), qr: null });
    } else if (kind === "session") {
      this.set({ phase: "session", failures, refreshError: rpcErrorMessage(kind), qr: null });
    } else {
      // mantém o último estado conhecido (se houver), sinalizado como desatualizado;
      // o QR é retirado: não dá para garantir que ainda vale
      this.set({
        phase: this.state.snapshot ? "ready" : "error",
        failures,
        refreshError: rpcErrorMessage(kind),
        qr: null,
      });
    }
  }

  private onSnapshot(snapshot: WaStatusSnapshot) {
    const now = this.clock.now();
    const waitingSince =
      snapshot.status === "connect_requested" ? (this.state.snapshot?.status === "connect_requested" && this.state.waitingSince) || now : null;
    this.set({
      phase: "ready",
      snapshot,
      failures: 0,
      refreshError: null,
      waitingSince,
      workerSlow: isWorkerSlow(snapshot.status, waitingSince, now),
      // o aviso "pedido enviado" some quando o banco já mostra outro momento
      notice: snapshot.status === "connected" || snapshot.status === "disconnected" ? null : this.state.notice,
    });
    if (this.slowTimer) this.clock.clearTimeout(this.slowTimer);
    this.slowTimer = null;
    if (waitingSince !== null && !this.state.workerSlow) {
      const left = waitingSince + WORKER_SLOW_MS - now + 1;
      this.slowTimer = this.clock.setTimeout(() => {
        this.slowTimer = null;
        if (this.state.snapshot?.status === "connect_requested" && this.state.waitingSince !== null) {
          this.set({ workerSlow: isWorkerSlow("connect_requested", this.state.waitingSince, this.clock.now()) });
        }
      }, Math.max(1, left));
    }
  }

  private async fetchQr() {
    let res: RpcResult;
    try {
      res = await this.api.getQr();
    } catch (e) {
      res = { error: { message: e instanceof Error ? e.message : "failed to fetch" } };
    }
    if (this.stopped) return;
    const qr = res.error ? null : parseQr(res.data);
    if (!qr) {
      if (this.state.qr) this.set({ qr: null });
      return;
    }
    if (this.state.qr?.value === qr.value) return; // mesmo QR: mantém o prazo original
    const now = this.clock.now();
    const deadline = qrLocalDeadline(qr.expiresAt, now);
    this.set({ qr: { value: qr.value, deadline } });
    if (this.qrTimer) this.clock.clearTimeout(this.qrTimer);
    this.qrTimer = this.clock.setTimeout(() => {
      this.qrTimer = null;
      if (this.state.qr && this.state.qr.deadline <= this.clock.now()) {
        this.set({ qr: null });
        void this.refresh(); // pede o QR seguinte, se houver
      }
    }, Math.max(1, deadline - now));
  }

  private async runAction(kind: "connect" | "disconnect") {
    if (this.state.pending || this.stopped) return;
    this.set({ pending: kind, actionError: null, notice: null });
    let res: RpcResult;
    try {
      res = kind === "connect" ? await this.api.requestConnection() : await this.api.disconnect();
    } catch (e) {
      res = { error: { message: e instanceof Error ? e.message : "failed to fetch" } };
    }
    if (this.stopped) return;
    if (res.error) {
      const k = classifyRpcError(res.error);
      this.set({
        pending: null,
        actionError:
          k === "network" || k === "unknown"
            ? kind === "connect"
              ? "Não foi possível pedir a conexão. Verifique a internet e tente de novo."
              : "Não foi possível pedir a desconexão. Verifique a internet e tente de novo."
            : rpcErrorMessage(k),
      });
      return;
    }
    this.set({
      pending: null,
      notice: kind === "connect" ? "Pedido de conexão enviado. Aguarde o QR Code." : "Pedido de desconexão enviado.",
    });
    this.seq++; // descarta qualquer consulta antiga em andamento
    this.inFlight = null;
    await this.refresh();
  }

  connect() {
    return this.runAction("connect");
  }

  disconnect() {
    return this.runAction("disconnect");
  }
}
