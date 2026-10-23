"use client";

// MFA por aplicativo autenticador (TOTP, nativo do Supabase Auth).
//   * sem fator confirmado: cadastra um novo (QR + chave) e confirma com o código;
//   * com fator confirmado: só pede o código.
// Ao confirmar, a sessão passa a ser aal2 — é isso que admin_assert() exige.
// O segredo do autenticador nunca é guardado pelo app: só aparece nesta tela.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle } from "lucide-react";

type State =
  | { step: "loading" }
  | { step: "enroll"; factorId: string; qr: string; secret: string }
  | { step: "verify"; factorId: string }
  | { step: "failed"; message: string };

export function AdminMfa({ email }: { email: string }) {
  const [state, setState] = useState<State>({ step: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const mfa = createClient().auth.mfa;
      const { data, error: e } = await mfa.listFactors();
      if (e || !data) return setState({ step: "failed", message: "Não foi possível consultar a verificação em duas etapas." });
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setState({ step: "verify", factorId: verified.id });
      // Cadastro anterior não confirmado: remove para começar limpo.
      for (const f of data.all.filter((x) => x.factor_type === "totp" && x.status !== "verified")) {
        await mfa.unenroll({ factorId: f.id });
      }
      // issuer explícito: sem ele o Supabase deriva o nome do Site URL do projeto e
      // falha ("site url is improperly formatted") se o Site URL estiver sem https://.
      const { data: en, error: ee } = await mfa.enroll({
        factorType: "totp",
        issuer: "Áurea",
        friendlyName: `Áurea admin (${email})`,
      });
      if (ee || !en || en.type !== "totp") {
        return setState({
          step: "failed",
          message: `Não foi possível iniciar o cadastro${ee?.message ? ` (${ee.message})` : ""}. Confira se o MFA por aplicativo está ativo no Supabase (Authentication → Multi-Factor) e se o Site URL começa com https://.`,
        });
      }
      setState({ step: "enroll", factorId: en.id, qr: en.totp.qr_code, secret: en.totp.secret });
    })();
  }, [email]);

  async function confirm() {
    if (state.step !== "enroll" && state.step !== "verify") return;
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) return setError("Digite os 6 números do aplicativo.");
    setBusy(true);
    setError(null);
    const { error: e } = await createClient().auth.mfa.challengeAndVerify({ factorId: state.factorId, code: clean });
    if (e) {
      setBusy(false);
      setCode("");
      return setError("Código incorreto ou expirado. Use o código que aparece agora no aplicativo.");
    }
    window.location.href = "/admin"; // recarrega para o servidor ler a sessão nova (aal2)
  }

  if (state.step === "loading") return <p className="mt-6 text-sm text-ink-500">Carregando…</p>;
  if (state.step === "failed") {
    return (
      <p role="alert" className="mt-6 flex items-start gap-1.5 text-sm text-danger">
        <AlertCircle className="mt-0.5 size-4 shrink-0" /> {state.message}
      </p>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {state.step === "enroll" && (
        <div className="space-y-3 rounded-lg bg-sand px-4 py-4">
          <p className="text-sm text-ink-700">
            Primeiro acesso: no Google Authenticator, Microsoft Authenticator ou 1Password, leia o QR code abaixo.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL gerada pelo Supabase */}
          <img src={state.qr} alt="QR code para o aplicativo autenticador" className="mx-auto size-44 rounded bg-white p-2" />
          <p className="text-xs text-ink-500">
            Sem câmera? Digite a chave: <span className="break-all font-semibold text-ink-700">{state.secret}</span>
          </p>
        </div>
      )}
      <Input
        label="Código de 6 números"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && confirm()}
        autoFocus
      />
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
        </p>
      )}
      <Button className="w-full" onClick={confirm} disabled={busy}>
        {busy ? "Confirmando…" : state.step === "enroll" ? "Ativar e entrar no painel" : "Entrar no painel"}
      </Button>
    </div>
  );
}
