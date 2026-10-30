"use client";

// Tela de WhatsApp — ligação com o banco. Usa SÓ as RPCs da 0017
// (wa_get_status, wa_get_qr, wa_request_connection, wa_disconnect); as regras
// de quem pode o quê estão nelas. O QR vira desenho (SVG) no próprio aparelho:
// o texto do código não é enviado a nenhum outro serviço.
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { WhatsappController, initialState, type WaApi, type WaViewState } from "@/lib/hive/whatsapp-controller";
import { WhatsappView } from "./whatsapp-view";

export function WhatsappPanel({ companyId, role, api }: { companyId: string; role: string; api?: WaApi }) {
  const [state, setState] = useState<WaViewState>(initialState);
  const [now, setNow] = useState(() => Date.now());
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ctrl = useRef<WhatsappController | null>(null);

  useEffect(() => {
    const rpc =
      api ??
      (() => {
        const supabase = createClient();
        const call = (fn: string) => async () => {
          const { data, error } = await supabase.rpc(fn, { p_company_id: companyId });
          return { data, error };
        };
        return {
          getStatus: call("wa_get_status"),
          getQr: call("wa_get_qr"),
          requestConnection: call("wa_request_connection"),
          disconnect: call("wa_disconnect"),
        } satisfies WaApi;
      })();
    const c = new WhatsappController(rpc, { role, onChange: setState });
    ctrl.current = c;
    c.start();
    const onVisibility = () => c.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      c.stop();
      ctrl.current = null;
    };
  }, [companyId, role, api]);

  // contagem regressiva do QR (só enquanto há QR na tela)
  const hasQr = Boolean(state.qr);
  useEffect(() => {
    if (!hasQr) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasQr]);

  // desenha o QR no aparelho
  const qrValue = state.qr?.value ?? null;
  useEffect(() => {
    let alive = true;
    if (!qrValue) {
      setQrSvg(null);
      return;
    }
    import("qrcode")
      .then((QR) => QR.toString(qrValue, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#2A1D16", light: "#FFFFFF" } }))
      .then((svg) => alive && setQrSvg(svg))
      .catch(() => alive && setQrSvg(null));
    return () => {
      alive = false;
    };
  }, [qrValue]);

  const onConnect = useCallback(() => void ctrl.current?.connect(), []);
  const onRetry = useCallback(() => void ctrl.current?.refresh(), []);
  const onConfirmDisconnect = useCallback(async () => {
    setConfirmOpen(false);
    await ctrl.current?.disconnect();
  }, []);

  const connected = state.snapshot?.status === "connected";

  return (
    <>
      <WhatsappView
        state={state}
        role={role}
        now={now}
        qrSvg={qrSvg}
        onConnect={onConnect}
        onAskDisconnect={() => setConfirmOpen(true)}
        onRetry={onRetry}
      />
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={connected ? "Desconectar o WhatsApp?" : "Cancelar a conexão?"}
      >
        <p className="text-sm text-ink-500">
          {connected
            ? "O aparelho será desvinculado da Sócia. As confirmações voltam a abrir o WhatsApp no celular. Para conectar de novo, será preciso ler um novo QR Code."
            : "O pedido de conexão será cancelado. Você pode pedir de novo quando quiser."}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
            Voltar
          </Button>
          <Button variant="danger" onClick={onConfirmDisconnect}>
            {connected ? "Desconectar" : "Cancelar conexão"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
