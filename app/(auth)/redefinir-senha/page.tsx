"use client";

// Recuperação de senha — passo 2: o link do e-mail abre esta tela. Ela valida o
// link (token_hash, code ou sessão já aberta pelo Supabase) e grava a nova senha.
import { useEffect, useState } from "react";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { parseRecoveryLink, passwordProblem, PASSWORD_MIN } from "@/lib/hive/auth-recovery";

type Stage = "checking" | "ready" | "invalid" | "done";

export default function RedefinirSenhaPage() {
  const [stage, setStage] = useState<Stage>("checking");
  const [invalidText, setInvalidText] = useState("Este link não é válido. Peça um novo link de recuperação.");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const supabase = createClient();
      const link = parseRecoveryLink(window.location.search, window.location.hash);
      let ok = false;
      if (link.kind === "error") {
        setInvalidText(link.message);
      } else if (link.kind === "token_hash") {
        ok = !(await supabase.auth.verifyOtp({ type: "recovery", token_hash: link.tokenHash })).error;
      } else if (link.kind === "code") {
        ok = !(await supabase.auth.exchangeCodeForSession(link.code)).error;
        if (!ok) setInvalidText("Abra o link no mesmo aparelho e navegador em que você pediu a recuperação, ou peça um novo link.");
      } else {
        ok = !!(await supabase.auth.getSession()).data.session;
      }
      // tira o código do endereço (não fica no histórico do navegador)
      if (ok) window.history.replaceState(null, "", "/redefinir-senha");
      if (alive) setStage(ok ? "ready" : "invalid");
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const { error: err } = await createClient().auth.updateUser({ password });
    setSaving(false);
    if (err) {
      setError(/same|different/i.test(err.message) ? "Escolha uma senha diferente da anterior." : "Não foi possível salvar a nova senha. Peça um novo link e tente de novo.");
      return;
    }
    setStage("done");
    setTimeout(() => {
      window.location.href = "/inicio";
    }, 1500);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cream px-6">
      <div className="w-full max-w-sm surface-white rounded-lg border border-ink-100 bg-white p-8 dark:bg-surface">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Image src="/logo-lockup.png" alt="Sócia" width={260} height={81} priority className="h-auto w-[240px] dark:hidden" />
          <Image src="/logo-lockup-dark.png" alt="Sócia" width={260} height={81} className="h-auto w-[240px] hidden dark:block" />
          <p className="text-sm text-ink-400">Criar nova senha</p>
        </div>
        {stage === "checking" && <p className="text-center text-sm text-ink-400">Conferindo o link...</p>}
        {stage === "invalid" && (
          <div className="space-y-4">
            <p className="text-sm text-danger" role="alert">
              {invalidText}
            </p>
            <a href="/esqueci-senha" className="block text-center text-sm font-medium text-ink-700 hover:text-ink-900">
              Pedir um novo link
            </a>
          </div>
        )}
        {stage === "ready" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input type="password" placeholder={`Nova senha (mínimo ${PASSWORD_MIN} caracteres)`} required autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <Input type="password" placeholder="Repita a nova senha" required autoComplete="new-password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {error && (
              <p className="text-sm text-danger" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" loading={saving} className="w-full">
              {saving ? "Salvando..." : "Salvar nova senha"}
            </Button>
          </form>
        )}
        {stage === "done" && (
          <p className="rounded-lg bg-sand px-4 py-3 text-sm text-ink-700" role="status">
            Senha alterada. Entrando...
          </p>
        )}
      </div>
    </main>
  );
}
