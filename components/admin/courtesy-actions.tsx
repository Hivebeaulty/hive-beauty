"use client";

// Cortesia com prazo (0054). O navegador só chama a função admin-courtesy e as funções admin_courtesy_*
// com a sessão (MFA) da superadmin: o banco decide quem pode e grava a auditoria.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  COURTESY_MAX_DAYS, COURTESY_MIN_DAYS, COURTESY_PRESETS, ORIGIN_LABEL, courtesyEndPreview, courtesyErrorMessage,
  extendEndPreview, grantFormProblem, grantResultMessage, reasonProblem, type CourtesyOrigin,
} from "@/lib/hive/courtesy";
import { AlertCircle, Gift, Mail, CalendarPlus, XCircle } from "lucide-react";

async function callCourtesy(body: Record<string, unknown>) {
  const { data, error } = await createClient().functions.invoke("admin-courtesy", { body });
  if (!error) return { ok: true as const, data: data as Record<string, unknown> };
  const res = (error as { context?: Response }).context;
  let parsed: { error?: string; code?: string } | null = null;
  try { parsed = res ? await res.json() : null; } catch { parsed = null; }
  return { ok: false as const, message: courtesyErrorMessage(parsed?.code ?? (res?.status === 403 ? "AUA01" : null), parsed?.error) };
}

const ErrorLine = ({ text }: { text: string | null }) =>
  text ? (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
      <AlertCircle className="mt-0.5 size-4 shrink-0" /> {text}
    </p>
  ) : null;

/** "Nova cortesia": e-mail que a dona digita, prazo (30, 90 ou outro), origem e motivo. */
export function NewCourtesy({ presetEmail }: { presetEmail?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [email, setEmail] = useState(presetEmail ?? "");
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<number | "other">(30);
  const [other, setOther] = useState("45");
  const [origin, setOrigin] = useState<CourtesyOrigin | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = preset === "other" ? Number(other) : preset;
  const form = { email, name, days, origin, reason };
  const endDay = Number.isInteger(days) && days >= COURTESY_MIN_DAYS && days <= COURTESY_MAX_DAYS ? courtesyEndPreview(days) : null;

  function reset() {
    setStep("form"); setError(null); setName(""); setPreset(30); setOther("45"); setOrigin(""); setReason("");
    setEmail(presetEmail ?? "");
  }
  function review() {
    const p = grantFormProblem(form);
    if (p) return setError(p);
    setError(null);
    setStep("confirm");
  }
  async function submit() {
    setBusy(true);
    setError(null);
    const r = await callCourtesy({ action: "grant", email: email.trim(), name: name.trim() || null, days, origin, reason: reason.trim() });
    setBusy(false);
    if (!r.ok) { setStep("form"); return setError(r.message); }
    toast.success(grantResultMessage(r.data as Parameters<typeof grantResultMessage>[0], email.trim().toLowerCase(), endDay ?? ""));
    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <>
      <Button onClick={() => { reset(); setOpen(true); }}>
        <Gift className="size-4" /> Nova cortesia
      </Button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title={step === "form" ? "Nova cortesia" : "Confirmar cortesia"}>
        {step === "form" ? (
          <div className="space-y-4 text-sm">
            <p className="text-ink-600">Você oferece o acesso a quem quiser. A pessoa recebe um e-mail para criar a senha; nada é cobrado.</p>
            <Input label="E-mail da pessoa" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input label="Nome (opcional)" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-ink-700">Prazo</span>
              <div className="flex flex-wrap gap-2">
                {COURTESY_PRESETS.map((d) => (
                  <button key={d} type="button" onClick={() => setPreset(d)} aria-pressed={preset === d}
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium ${preset === d ? "border-ink-800 bg-ink-800 text-cream" : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-50"}`}>
                    {d} dias
                  </button>
                ))}
                <button type="button" onClick={() => setPreset("other")} aria-pressed={preset === "other"}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium ${preset === "other" ? "border-ink-800 bg-ink-800 text-cream" : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-50"}`}>
                  Outro
                </button>
              </div>
              {preset === "other" && (
                <Input label="Quantos dias (1 a 365)" type="number" inputMode="numeric" min={COURTESY_MIN_DAYS} max={COURTESY_MAX_DAYS} value={other} onChange={(e) => setOther(e.target.value)} />
              )}
              <p className="text-xs text-ink-500">{endDay ? `Vale até ${endDay}, às 23:59.` : "Escolha um prazo entre 1 e 365 dias."}</p>
            </div>
            <Select label="Origem" value={origin} onChange={(e) => setOrigin(e.target.value as CourtesyOrigin | "")}>
              <option value="">Escolha…</option>
              {(Object.keys(ORIGIN_LABEL) as CourtesyOrigin[]).map((o) => <option key={o} value={o}>{ORIGIN_LABEL[o]}</option>)}
            </Select>
            <Textarea label="Motivo (fica registrado na auditoria)" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <ErrorLine text={error} />
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button onClick={review} className="sm:flex-1">Revisar</Button>
              <Button variant="secondary" onClick={() => setOpen(false)} className="sm:flex-1">Voltar</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <ul className="list-disc space-y-1 pl-5 text-ink-600">
              <li>Cortesia para <strong className="text-ink-800">{email.trim().toLowerCase()}</strong>{name.trim() ? ` (${name.trim()})` : ""}.</li>
              <li>Vale até <strong className="text-ink-800">{endDay}</strong>, às 23:59.</li>
              <li>Se o e-mail ainda não tem conta, a pessoa recebe o e-mail para criar a senha. Se já tem, entra com a senha de sempre.</li>
              <li>Sete dias antes do fim, ela vê um aviso no app. Depois do prazo, o acesso pausa e ela pode assinar. Nenhum dado é apagado.</li>
            </ul>
            <ErrorLine text={error} />
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button onClick={submit} loading={busy} className="sm:flex-1">{busy ? "Criando…" : "Oferecer cortesia"}</Button>
              <Button variant="secondary" onClick={() => setStep("form")} disabled={busy} className="sm:flex-1">Voltar</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/** Estender, encerrar agora e reenviar o e-mail de criar senha. */
export function CourtesyRowActions({
  id, email, endsAt, canExtend, canRevoke, canInvite,
}: { id: string | null; email: string; endsAt: string | null; canExtend: boolean; canRevoke: boolean; canInvite: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<null | "extend" | "revoke">(null);
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const p = reasonProblem(reason);
    if (p) return setError(p);
    if (!id) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: err } = mode === "extend"
      ? await supabase.rpc("admin_courtesy_extend", { p_courtesy_id: id, p_days: days, p_reason: reason.trim() })
      : await supabase.rpc("admin_courtesy_revoke", { p_courtesy_id: id, p_reason: reason.trim() });
    setBusy(false);
    if (err) return setError(courtesyErrorMessage(err.code, err.message));
    toast.success(mode === "extend" ? `Cortesia de ${email} estendida até ${extendEndPreview(endsAt, days)}.` : `Cortesia de ${email} encerrada.`);
    setMode(null);
    setReason("");
    router.refresh();
  }
  async function resend() {
    setBusy(true);
    const r = await callCourtesy({ action: "invite", email });
    setBusy(false);
    if (!r.ok) return toast.error(r.message);
    toast.success(`E-mail para criar a senha enviado para ${email}.`);
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {canExtend && id && (
        <Button size="sm" variant="secondary" onClick={() => { setError(null); setDays(30); setMode("extend"); }}>
          <CalendarPlus className="size-4" /> Estender
        </Button>
      )}
      {canRevoke && id && (
        <Button size="sm" variant="secondary" onClick={() => { setError(null); setMode("revoke"); }}>
          <XCircle className="size-4" /> Encerrar agora
        </Button>
      )}
      {canInvite && (
        <Button size="sm" variant="secondary" onClick={resend} disabled={busy}>
          <Mail className="size-4" /> Reenviar e-mail
        </Button>
      )}
      <Modal open={mode !== null} onClose={() => !busy && setMode(null)} title={mode === "extend" ? "Estender a cortesia" : "Encerrar a cortesia"}>
        <div className="space-y-4 text-sm">
          {mode === "extend" ? (
            <>
              <div className="flex flex-wrap gap-2">
                {COURTESY_PRESETS.map((d) => (
                  <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium ${days === d ? "border-ink-800 bg-ink-800 text-cream" : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-50"}`}>
                    +{d} dias
                  </button>
                ))}
              </div>
              <Input label="Ou outro número de dias (1 a 365)" type="number" inputMode="numeric" min={COURTESY_MIN_DAYS} max={COURTESY_MAX_DAYS}
                     value={String(days)} onChange={(e) => setDays(Number(e.target.value))} />
              <p className="text-ink-600">
                {Number.isInteger(days) && days >= COURTESY_MIN_DAYS && days <= COURTESY_MAX_DAYS
                  ? `Passa a valer até ${extendEndPreview(endsAt, days)}, às 23:59.`
                  : "Escolha entre 1 e 365 dias."}
              </p>
            </>
          ) : (
            <p className="text-ink-600">O acesso de <strong className="text-ink-800">{email}</strong> pausa agora. Nada é apagado, e ela pode assinar para voltar. Para dar nova cortesia depois, crie outra.</p>
          )}
          <Textarea label="Motivo (fica registrado na auditoria)" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <ErrorLine text={error} />
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button variant={mode === "revoke" ? "danger" : "primary"} onClick={run} loading={busy} className="sm:flex-1">
              {mode === "extend" ? "Estender cortesia" : "Encerrar cortesia"}
            </Button>
            <Button variant="secondary" onClick={() => setMode(null)} disabled={busy} className="sm:flex-1">Voltar</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
