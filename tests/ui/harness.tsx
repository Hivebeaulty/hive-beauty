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
import { TodaySummary } from "@/components/dashboard/today-summary";
import { Stat } from "@/components/ui/stat";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { CalendarX } from "lucide-react";

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
        {view === "dashboard" ? (
          // Sprint visual: painel "Hoje" + "Negócio no mês" com números reais grandes (pior caso de largura)
          (() => {
            const q = new URLSearchParams(location.search);
            const money = Number(q.get("money") ?? "12345.67");
            const fin = q.get("fin") !== "0";
            const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
            return (
              <div className="space-y-6">
                <div>
                  <h1 className="font-serif text-[26px] italic text-ink-800 sm:text-[30px]">Boa tarde, Patrícia.</h1>
                  <p className="text-sm text-ink-400">Veja como está o seu negócio hoje.</p>
                </div>
                <TodaySummary loading={q.get("loading") === "1"} canSeeFinance={fin} received={money}
                  appointmentsToday={Number(q.get("today") ?? "12")} upcoming={Number(q.get("up") ?? "148")} dateLabel="quinta-feira, 15 de outubro" />
                <Card data-testid="month">
                  <h2 className="mb-4 text-sm font-semibold text-ink-700">Negócio no mês</h2>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
                    {fin && <Stat size="sm" accent value={fmt.format(money * 9)} label="Recebido" className="col-span-2 sm:col-span-1" />}
                    <Stat size="sm" value={286} label="Atendimentos" />
                    <Stat size="sm" value={143} label="Clientes ativas" />
                    <Stat size="sm" value={27} label="Clientes novas" />
                  </div>
                </Card>
              </div>
            );
          })()
        ) : view === "kit" ? (
          <div className="space-y-5">
            <PageHeader title="Clientes" description="Acompanhe quem volta e quem sumiu." actions={<Button size="sm">Nova cliente</Button>} />
            <Card>
              <div className="flex flex-wrap gap-2">
                <StatusBadge status="agendado" /><StatusBadge status="confirmado" /><StatusBadge status="concluido" />
                <StatusBadge status="cancelado" /><StatusBadge status="nao_compareceu" /><Badge tone="gold">Plano Ouro</Badge>
              </div>
              <p className="mt-3 text-sm text-ink-400">Texto secundário com o novo contraste, usado em toda a interface.</p>
            </Card>
            <Card tone="sand"><p className="text-sm text-ink-700">Cartão areia para agrupar conteúdo secundário.</p></Card>
            <div className="flex flex-wrap gap-2"><Button>Salvar</Button><Button variant="secondary">Cancelar</Button><Button variant="ghost">Voltar</Button><Button variant="danger">Excluir</Button></div>
            <EmptyState icon={CalendarX} title="Nenhum atendimento hoje" description="Aproveite para organizar a agenda dos próximos dias." />
          </div>
        ) : view === "auto" ? (
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
