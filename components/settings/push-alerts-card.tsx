"use client";
// Avisos no celular (0048 e 0049). Pessoal: vale para QUALQUER papel e para este aparelho.
//   * antes do atendimento: antecedência de 15 min, 30 min, 1 h, 2 h ou desligado (push_prefs);
//   * clientes sumidas: um aviso por semana, que a pessoa pode desligar (0049).
// Se a migration 0048 ainda não foi aplicada, o card some; sem a 0049, só some a opção das sumidas.
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ALERT_OPTIONS, DEFAULT_ALERT_MINUTES, urlBase64ToUint8Array } from "@/lib/hive/push-alerts";

type Support = "checking" | "ready" | "denied" | "ios-install" | "unsupported";

function detectSupport(): Support {
  if (typeof window === "undefined") return "checking";
  const hasPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (hasPush) return Notification.permission === "denied" ? "denied" : "ready";
  // iPhone/iPad: o push só existe com a Sócia instalada na tela inicial (iOS 16.4 ou mais novo).
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios ? "ios-install" : "unsupported";
}

async function saveSubscription(sub: PushSubscription) {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new Error("inscrição incompleta");
  const { error } = await createClient().rpc("push_save_subscription", {
    p_endpoint: json.endpoint,
    p_p256dh: p256dh,
    p_auth: auth,
    p_user_agent: navigator.userAgent.slice(0, 200),
  });
  if (error) throw error;
}

export function PushAlertsCard() {
  const toast = useToast();
  const { memberId } = useCompany();
  const [support, setSupport] = useState<Support>("checking");
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hasDevice, setHasDevice] = useState(false);
  const [minutes, setMinutes] = useState<number | null>(null);
  // Aviso semanal de clientes sumidas: null = indisponível (migration 0049 ainda não aplicada).
  const [overdue, setOverdue] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = detectSupport();
      const { data, error } = await createClient().rpc("push_get_alert_minutes", { p_member_id: memberId });
      if (cancelled) return;
      if (error) {
        setAvailable(false);
        setLoading(false);
        return;
      }
      setMinutes(typeof data === "number" ? data : null);
      const od = await createClient().rpc("push_get_overdue_alert", { p_member_id: memberId });
      if (cancelled) return;
      setOverdue(od.error ? null : od.data === true);
      setSupport(s);
      if (s === "ready" && Notification.permission === "granted") {
        try {
          const reg = await navigator.serviceWorker.getRegistration("/");
          const sub = await reg?.pushManager.getSubscription();
          if (sub) {
            setHasDevice(true);
            await saveSubscription(sub); // mantém o aparelho em dia no banco
          }
        } catch {
          /* sem inscrição: o botão de ativar aparece */
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  async function saveMinutes(value: number | null) {
    const { error } = await createClient().rpc("push_set_alert_minutes", { p_member_id: memberId, p_minutes: value });
    if (error) throw error;
    setMinutes(value);
  }

  async function chooseOverdue(value: boolean) {
    const before = overdue;
    setOverdue(value);
    const { error } = await createClient().rpc("push_set_overdue_alert", { p_member_id: memberId, p_enabled: value });
    if (error) {
      setOverdue(before);
      toast.error("Não foi possível salvar. Tente novamente.");
    }
  }

  async function enable() {
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) {
      toast.error("Os avisos ainda não estão disponíveis. Fale com o suporte.");
      return;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setSupport(permission === "denied" ? "denied" : "ready");
        toast.error("Sem a permissão do celular não dá para enviar os avisos.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
      await saveSubscription(sub);
      await saveMinutes(minutes ?? DEFAULT_ALERT_MINUTES);
      setHasDevice(true);
      toast.success("Pronto! Vou te avisar antes de cada atendimento.");
    } catch {
      toast.error("Não foi possível ativar os avisos. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  async function choose(value: number | null) {
    const before = minutes;
    setMinutes(value);
    try {
      await saveMinutes(value);
    } catch {
      setMinutes(before);
      toast.error("Não foi possível salvar. Tente novamente.");
    }
  }

  async function disableDevice() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await createClient().rpc("push_remove_subscription", { p_endpoint: endpoint });
      }
      setHasDevice(false);
      toast.success("Avisos desativados neste aparelho.");
    } catch {
      toast.error("Não foi possível desativar. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      await reg?.showNotification("Sócia", {
        body: "Assim vai aparecer o aviso antes do atendimento.",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
      });
    } catch {
      toast.error("Não foi possível mostrar o aviso de teste.");
    }
  }

  if (!available) return null;

  const options: { value: number | null; label: string }[] = [...ALERT_OPTIONS, { value: null, label: "Desligado" }];

  return (
    <Card className="space-y-3" data-testid="push-alerts">
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 size-5 shrink-0 text-ink-700" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold text-ink-800">Avisos no celular</h2>
          <p className="mt-1 text-sm text-ink-500">
            Receba uma notificação no celular um tempo antes de cada cliente, com o nome, o serviço e o horário, e um lembrete semanal das clientes que sumiram.
          </p>
        </div>
      </div>

      {loading || support === "checking" ? null : support === "ios-install" ? (
        <p className="text-sm text-ink-600">
          No iPhone, instale a Sócia na tela inicial (botão Compartilhar, depois &quot;Adicionar à Tela de Início&quot;) e abra por lá
          para ativar os avisos.
        </p>
      ) : support === "unsupported" ? (
        <p className="text-sm text-ink-600">Este navegador não permite avisos. Tente pelo Chrome ou pelo app instalado.</p>
      ) : support === "denied" ? (
        <p className="text-sm text-ink-600">
          Os avisos estão bloqueados neste aparelho. Libere as notificações da Sócia nas configurações do celular ou do
          navegador e volte aqui.
        </p>
      ) : !hasDevice ? (
        <Button size="sm" onClick={enable} loading={busy}>
          {busy ? "Ativando..." : "Ativar avisos neste aparelho"}
        </Button>
      ) : (
        <>
          <p className="text-xs font-semibold text-ink-500">Aviso antes de cada atendimento</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Quanto tempo antes avisar">
            {options.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                role="radio"
                aria-checked={minutes === o.value}
                onClick={() => choose(o.value)}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left text-sm font-semibold text-ink-800 transition-colors",
                  minutes === o.value ? "border-gold-500 bg-sand" : "border-ink-100 hover:bg-sand/60"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {overdue !== null && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-ink-100 px-3 py-2.5">
              <div>
                <p className="text-sm font-semibold text-ink-800">Clientes sumidas</p>
                <p className="mt-0.5 text-xs text-ink-500">
                  Toda segunda-feira, às 9h, um aviso com quantas clientes passaram da hora de voltar, para você chamar no WhatsApp.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={overdue}
                aria-label="Avisar sobre clientes sumidas"
                onClick={() => chooseOverdue(!overdue)}
                className={cn(
                  "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors",
                  overdue ? "bg-ink-800" : "bg-ink-200"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                    overdue ? "left-[22px]" : "left-0.5"
                  )}
                />
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={sendTest}>
              Testar neste aparelho
            </Button>
            <Button size="sm" variant="ghost" onClick={disableDevice} loading={busy}>
              Desativar neste aparelho
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
