"use client";

// Mais > Assinatura (0051): a DONA vê a própria assinatura e cancela sem sair da Sócia.
// Os dados vêm de my_subscription (o banco só responde para a dona ativa da empresa);
// o cancelamento passa pela função account-billing, que fala com o Mercado Pago.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { checkoutUrlFor } from "@/lib/hive/access";
import { formatMoney } from "@/lib/hive/format";
import {
  CANCEL_REASONS, MP_SUBSCRIPTIONS_URL, cancelWarning, describeSubscription, formatDayBR, parseSubscription, paymentLabel,
  type Subscription,
} from "@/lib/hive/subscription";
import { cn } from "@/lib/utils";
import { AlertCircle, ChevronLeft, ExternalLink } from "lucide-react";

async function cancelSubscription(companyId: string, reason: string) {
  const { data, error } = await createClient().functions.invoke("account-billing", {
    body: { action: "cancel", company_id: companyId, reason },
  });
  if (!error) return { ok: true as const, data };
  // Erro HTTP da função: mostra o motivo que o banco ou o Mercado Pago deram.
  const res = (error as { context?: Response }).context;
  let parsed: { error?: string } | null = null;
  try { parsed = res ? await res.json() : null; } catch { parsed = null; }
  return { ok: false as const, message: parsed?.error ?? "Não foi possível cancelar agora. Tente de novo em alguns minutos." };
}

export default function AssinaturaPage() {
  const { companyId, role } = useCompany();
  const toast = useToast();
  const isOwner = role === "owner";
  const [sub, setSub] = useState<Subscription | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isOwner) return;
    setState("loading");
    const { data, error } = await createClient().rpc("my_subscription", { p_company_id: companyId });
    const parsed = parseSubscription(data, error);
    setSub(parsed);
    setState(parsed ? "ready" : "error");
  }, [companyId, isOwner]);

  useEffect(() => {
    load();
  }, [load]);

  // Estável entre renders: o Modal refoca o diálogo quando onClose muda, e uma função
  // nova a cada letra digitada tiraria o foco do campo de texto.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const closeModal = useCallback(() => {
    if (!busyRef.current) setOpen(false);
  }, []);

  async function confirmCancel() {
    setBusy(true);
    setError(null);
    const text = [reason, note.trim()].filter(Boolean).join(" — ");
    const r = await cancelSubscription(companyId, text);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setOpen(false);
    setReason("");
    setNote("");
    toast.success("Assinatura cancelada. Não haverá novas cobranças.");
    load();
  }

  const back = (
    <Link href="/mais" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
      <ChevronLeft className="size-4" /> Mais
    </Link>
  );

  if (!isOwner) {
    return (
      <div className="space-y-4">
        {back}
        <h1 className="page-title">Assinatura</h1>
        <Card>
          <p className="text-ink-600">Só a dona da conta vê e muda a assinatura. Fale com ela se precisar de alguma coisa.</p>
        </Card>
      </div>
    );
  }

  const summary = sub ? describeSubscription(sub) : null;

  return (
    <div className="space-y-5 pb-4">
      {back}
      <h1 className="page-title">Assinatura</h1>

      {state === "loading" && (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {state === "error" && (
        <Card>
          <p className="text-ink-600">Não conseguimos carregar sua assinatura agora.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={load}>Tentar de novo</Button>
        </Card>
      )}

      {state === "ready" && sub && summary && (
        <>
          <Card data-testid="subscription-summary" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className={cn("font-serif text-lg font-medium", summary.tone === "warn" ? "text-warning" : "text-ink-800")}>{summary.title}</h2>
              {sub.amount !== null && sub.status !== "free" && (
                <span className="font-serif text-lg font-medium tabular-nums text-gold-700">
                  {formatMoney(sub.amount)}<span className="text-sm font-normal text-ink-400"> /mês</span>
                </span>
              )}
            </div>
            {summary.lines.map((l) => (
              <p key={l} className="text-sm leading-relaxed text-ink-600">{l}</p>
            ))}
            {sub.cancelPending && <p className="text-sm text-ink-500">Estamos confirmando o cancelamento com o Mercado Pago…</p>}
            {summary.canSubscribe && (
              <p className="rounded-lg bg-sand px-4 py-3 text-xs text-ink-700">
                No Mercado Pago, use o mesmo e-mail desta conta, para a assinatura ser ligada a ela.
              </p>
            )}

            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              {summary.canSubscribe && (
                <a href={checkoutUrlFor(sub.access.status, sub.provider)} target="_blank" rel="noopener noreferrer" className="sm:flex-1">
                  <Button variant="accent" className="w-full">{sub.provider === "trial" ? "Assinar agora" : "Assinar de novo"}</Button>
                </a>
              )}
              {!summary.canSubscribe && sub.status !== "free" && sub.provider !== "trial" && sub.access.status !== "ending" && (
                <a href={MP_SUBSCRIPTIONS_URL} target="_blank" rel="noopener noreferrer" className="sm:flex-1">
                  <Button variant="secondary" className="w-full">
                    Trocar forma de pagamento <ExternalLink className="size-4" />
                  </Button>
                </a>
              )}
            </div>
          </Card>

          {sub.payments.length > 0 && (
            <section className="space-y-2" aria-label="Cobranças">
              <h2 className="text-sm font-semibold text-ink-700">Cobranças</h2>
              <Card padding="none">
                <ul className="divide-y divide-ink-100">
                  {sub.payments.map((p) => (
                    <li key={`${p.at}-${p.status}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <p className="tabular-nums text-ink-800">{formatDayBR(p.at)}</p>
                        <p className={cn("text-ink-500", p.status === "rejected" && "text-danger")}>{paymentLabel(p)}</p>
                      </div>
                      <span className="shrink-0 tabular-nums text-ink-700">{p.amount !== null ? formatMoney(p.amount) : "—"}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {sub.canCancel && (
            <div className="pt-2">
              <Button variant="ghost" size="sm" onClick={() => { setError(null); setOpen(true); }} className="text-ink-500">
                Cancelar assinatura
              </Button>
            </div>
          )}

          <Modal open={open} onClose={closeModal} title="Cancelar a assinatura">
            <div className="space-y-4 text-sm">
              <p className="text-ink-600">{cancelWarning(sub)}</p>
              <p className="text-ink-600">Seus dados continuam guardados. Para voltar, é só assinar de novo com o mesmo e-mail.</p>
              <fieldset className="space-y-2">
                <legend className="font-medium text-ink-700">Se puder, conte o motivo (opcional)</legend>
                <div className="flex flex-wrap gap-2">
                  {CANCEL_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={reason === r}
                      onClick={() => setReason(reason === r ? "" : r)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-sm transition-colors",
                        reason === r ? "border-ink-800 bg-ink-800 text-cream" : "border-ink-200 text-ink-700 hover:border-ink-300"
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </fieldset>
              <Textarea label="Quer contar mais? (opcional)" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
              {error && (
                <p role="alert" className="flex items-start gap-1.5 text-danger">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
                </p>
              )}
              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button variant="danger" onClick={confirmCancel} disabled={busy} className="sm:flex-1">
                  {busy ? "Cancelando no Mercado Pago…" : "Cancelar assinatura"}
                </Button>
                <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy} className="sm:flex-1">
                  Continuar com a Sócia
                </Button>
              </div>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
