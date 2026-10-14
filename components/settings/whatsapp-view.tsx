"use client";

// Tela de WhatsApp — só desenho. Recebe o estado do controlador e devolve a
// interface; não fala com o banco. Quem pode conectar, ver o QR ou desconectar
// é decidido pelas RPCs (0017); aqui os botões só aparecem para quem o banco
// diz que pode (can_manage) E tem papel de administração.
import { Loader2, RefreshCw, Smartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { availableActions, describeStatus, formatConnectedPhone, qrSecondsLeft, QR_MAX_MS } from "@/lib/hive/whatsapp";
import type { WaViewState } from "@/lib/hive/whatsapp-controller";

export interface WhatsappViewProps {
  state: WaViewState;
  role: string;
  now: number;
  qrSvg: string | null;
  onConnect: () => void;
  onAskDisconnect: () => void;
  onRetry: () => void;
}

function formatSince(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WhatsappView({ state, role, now, qrSvg, onConnect, onAskDisconnect, onRetry }: WhatsappViewProps) {
  if (state.phase === "loading") {
    return (
      <Card aria-busy="true" aria-label="Carregando o status do WhatsApp">
        <Skeleton className="h-5 w-32 rounded-full" />
        <Skeleton className="mt-3 h-3.5 w-3/4" />
        <Skeleton className="mt-2 h-3.5 w-1/2" />
      </Card>
    );
  }

  if (state.phase === "unavailable" || state.phase === "session") {
    return (
      <Card>
        <p className="font-semibold text-ink-800">
          {state.phase === "unavailable" ? "WhatsApp indisponível" : "Sessão expirada"}
        </p>
        <p className="mt-1 text-sm text-ink-500">{state.refreshError}</p>
      </Card>
    );
  }

  if (state.phase === "error" || !state.snapshot) {
    return (
      <Card>
        <p className="font-semibold text-ink-800">Não foi possível consultar o WhatsApp</p>
        <p className="mt-1 text-sm text-ink-500">{state.refreshError}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="size-4" aria-hidden="true" />
          Tentar agora
        </Button>
      </Card>
    );
  }

  const snap = state.snapshot;
  const view = describeStatus(snap.status, { lastError: snap.lastError, workerSlow: state.workerSlow, canManage: snap.canManage });
  // Sem resposta do servidor, o que temos é só a ÚLTIMA informação: nada de
  // "Conectado" em verde nem de ações que dependem do servidor.
  const outdated = Boolean(state.refreshError);
  const actions = outdated ? { connect: false, disconnect: false, showQr: false } : availableActions(snap.status, snap.canManage, role);
  const phone = snap.status === "connected" ? formatConnectedPhone(snap.phone) : null;
  const since = snap.status === "connected" ? formatSince(snap.connectedAt) : null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0" aria-live="polite">
            <Badge tone={outdated ? "neutral" : view.tone} data-testid="wa-status">
              {outdated ? `Última informação: ${view.label}` : view.label}
            </Badge>
            {!outdated && <p className="mt-2 text-sm text-ink-500">{view.description}</p>}
          </div>
          {view.busy && !outdated && <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-ink-400 motion-reduce:animate-none" aria-hidden="true" />}
        </div>

        {phone && (
          <div className="mt-4 flex items-center gap-3 rounded-md bg-ink-50 px-3 py-2.5">
            <Smartphone className="size-4 shrink-0 text-ink-400" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold tabular-nums text-ink-800" data-testid="wa-phone">
                {phone}
              </p>
              {since && <p className="text-xs text-ink-400">Conectado em {since}</p>}
            </div>
          </div>
        )}

        {state.refreshError && (
          <p role="status" className="mt-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-ink-700" data-testid="wa-refresh-error">
            {state.refreshError} O que aparece aqui pode estar desatualizado.
          </p>
        )}
        {state.notice && !state.refreshError && <p className="mt-4 text-sm text-ink-500">{state.notice}</p>}
        {state.actionError && (
          <p role="alert" className="mt-4 text-sm font-medium text-danger">
            {state.actionError}
          </p>
        )}

        {(actions.connect || actions.disconnect || state.refreshError) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {actions.connect && (
              <Button onClick={onConnect} loading={state.pending === "connect"} disabled={state.pending !== null}>
                {snap.status === "disconnected" ? "Conectar WhatsApp" : "Conectar de novo"}
              </Button>
            )}
            {actions.disconnect && (
              <Button
                variant="secondary"
                onClick={onAskDisconnect}
                loading={state.pending === "disconnect"}
                disabled={state.pending !== null}
              >
                {snap.status === "connected" ? "Desconectar" : "Cancelar conexão"}
              </Button>
            )}
            {state.refreshError && (
              <Button variant="ghost" onClick={onRetry}>
                <RefreshCw className="size-4" aria-hidden="true" />
                Tentar agora
              </Button>
            )}
          </div>
        )}

        {!snap.canManage && (
          <p className="mt-4 text-xs text-ink-400">Só a administração da empresa conecta ou desconecta o WhatsApp.</p>
        )}
      </Card>

      {actions.showQr && <QrCard qr={state.qr} qrSvg={qrSvg} now={now} />}
    </div>
  );
}

function QrCard({ qr, qrSvg, now }: { qr: WaViewState["qr"]; qrSvg: string | null; now: number }) {
  const secondsLeft = qr ? qrSecondsLeft(qr.deadline, now) : 0;
  const visible = Boolean(qr && qrSvg && secondsLeft > 0);
  const fraction = qr ? Math.max(0, Math.min(1, (qr.deadline - now) / QR_MAX_MS)) : 0;

  return (
    <Card>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="mx-auto w-full max-w-[240px] shrink-0 sm:mx-0 sm:w-[200px]">
          {visible ? (
            <>
              <div
                role="img"
                aria-label="QR Code para conectar o WhatsApp da empresa"
                data-testid="wa-qr"
                className="aspect-square w-full rounded-md border border-ink-100 bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: qrSvg as string }}
              />
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-gold-500 motion-safe:transition-[width] motion-safe:duration-1000 motion-safe:ease-linear"
                  style={{ width: `${fraction * 100}%` }}
                />
              </div>
              <p className="mt-1.5 text-center text-xs tabular-nums text-ink-400" data-testid="wa-qr-seconds">
                Válido por {secondsLeft} s
              </p>
            </>
          ) : (
            <div
              className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-ink-200 bg-ink-50 text-center"
              data-testid="wa-qr-waiting"
            >
              <Loader2 className="size-5 animate-spin text-ink-400 motion-reduce:animate-none" aria-hidden="true" />
              <p className="px-4 text-xs text-ink-500">Gerando um novo código…</p>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <p className="font-semibold text-ink-800">No celular da empresa</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-ink-500 marker:text-ink-400">
            <li>Abra o WhatsApp no celular com o número da empresa.</li>
            <li>Toque em Configurações (ou nos três pontos) e depois em Aparelhos conectados.</li>
            <li>Toque em Conectar um aparelho e aponte a câmera para o código.</li>
          </ol>
        </div>
      </div>
    </Card>
  );
}
