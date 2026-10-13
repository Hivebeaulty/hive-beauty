// Palco de testes: o painel REAL da tela de WhatsApp com uma API simulada que o
// teste controla (window.__wa). Só o cliente do Supabase é trocado.
import { createRoot } from "react-dom/client";
import { WhatsappPanel } from "@/components/settings/whatsapp-panel";
import { WhatsappView } from "@/components/settings/whatsapp-view";
import { initialState } from "@/lib/hive/whatsapp-controller";
import type { RpcResult, WaApi } from "@/lib/hive/whatsapp-controller";
import { WhatsappAutoConfirmation } from "@/components/settings/whatsapp-auto-confirmation";
import { WhatsappConfirmationStatus } from "@/components/whatsapp-confirmation-status";
import { describeConfirmation, type ConfirmationState } from "@/lib/hive/whatsapp-confirmation";

type Scenario = { status: RpcResult; qr: RpcResult; request: RpcResult; disc: RpcResult; delayMs: number };
const sc: Scenario = {
  status: { data: { status: "disconnected", can_manage: true, can_send: false, qr_available: false } },
  qr: { data: { qr: null } },
  request: { data: { status: "connect_requested" } },
  disc: { data: { status: "disconnect_requested" } },
  delayMs: 30,
};
const calls: Record<string, number> = { getStatus: 0, getQr: 0, requestConnection: 0, disconnect: 0 };
const wait = () => new Promise((r) => setTimeout(r, sc.delayMs));
const api: WaApi = {
  async getStatus() { calls.getStatus++; await wait(); return sc.status; },
  async getQr() { calls.getQr++; await wait(); return sc.qr; },
  async requestConnection() { calls.requestConnection++; await wait(); return sc.request; },
  async disconnect() { calls.disconnect++; await wait(); return sc.disc; },
};
const w = window as unknown as { __wa: unknown; __initial?: Partial<Scenario> | null };
if (w.__initial) Object.assign(sc, w.__initial); // cenário do teste vale desde a primeira consulta
w.__wa = { sc, calls };

const role = new URLSearchParams(location.search).get("role") || "owner";
const view = new URLSearchParams(location.search).get("view") || "";
createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-cream">
    <main className="mx-auto max-w-3xl px-4 py-6 md:px-8">
      <div className="space-y-5 pb-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">WhatsApp</h1>
          <p className="mt-1 text-sm text-ink-500">Conexão do número de WhatsApp da empresa com a Áurea.</p>
        </div>
        {view === "auto" ? (
          // W5: preferência da empresa, falando com o cliente do Supabase simulado (window.__rpc)
          <WhatsappAutoConfirmation companyId="00000000-0000-0000-0000-000000000001" />
        ) : view === "confirmation" ? (
          // W5: situação da confirmação, um cartão por estado/motivo pedido na URL
          <div className="space-y-3">
            {(new URLSearchParams(location.search).get("cases") || "").split(",").filter(Boolean).map((cs) => {
              const [state, reason] = cs.split(":");
              const v = describeConfirmation({ state: state as ConfirmationState, reason: reason || null });
              return v ? (
                <div key={cs} data-case={cs} data-auto={String(v.autoHandled)} data-manual={String(v.allowManual)}>
                  <WhatsappConfirmationStatus view={v} />
                </div>
              ) : (
                <div key={cs} data-case={cs} data-empty="true" />
              );
            })}
          </div>
        ) : view === "expired-qr" ? (
          // só a parte visual, recebendo um QR JÁ VENCIDO (defesa própria da tela)
          <WhatsappView
            state={{
              ...initialState,
              phase: "ready",
              snapshot: { status: "qr_pending", phone: null, connectedAt: null, lastSeenAt: null, lastError: null, canManage: true, canSend: false, qrAvailable: true },
              qr: { value: "2@QR-VENCIDO-abcdefghijk", deadline: Date.now() - 1000 },
            }}
            role="owner"
            now={Date.now()}
            qrSvg={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'}
            onConnect={() => {}}
            onAskDisconnect={() => {}}
            onRetry={() => {}}
          />
        ) : (
          <WhatsappPanel companyId="00000000-0000-0000-0000-000000000001" role={role} api={api} />
        )}
      </div>
    </main>
  </div>
);
