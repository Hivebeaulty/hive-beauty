"use client";

// Recuperação de senha — passo 1: pedir o link por e-mail (Supabase Auth).
// A resposta é a MESMA para e-mail cadastrado ou não (não revela quem tem conta).
import { useState } from "react";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { resetRequestMessage } from "@/lib/hive/auth-recovery";

export default function EsqueciSenhaPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    const { error } = await createClient().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/redefinir-senha`,
    });
    setLoading(false);
    setResult(resetRequestMessage(error ? { status: error.status, code: error.code, message: error.message } : null));
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cream px-6">
      <div className="w-full max-w-sm surface-white rounded-lg border border-ink-100 bg-white p-8 dark:bg-surface">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Image src="/logo-lockup.png" alt="Sócia" width={260} height={81} priority className="h-auto w-[240px] dark:hidden" />
          <Image src="/logo-lockup-dark.png" alt="Sócia" width={260} height={81} className="h-auto w-[240px] hidden dark:block" />
          <p className="text-sm text-ink-400">Informe o e-mail da sua conta para receber um link de nova senha.</p>
        </div>
        {result?.ok ? (
          <p className="rounded-lg bg-sand px-4 py-3 text-sm text-ink-700" role="status">
            {result.text}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input type="email" placeholder="E-mail" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            {result && !result.ok && (
              <p className="text-sm text-danger" role="alert">
                {result.text}
              </p>
            )}
            <Button type="submit" loading={loading} className="w-full">
              {loading ? "Enviando..." : "Enviar link"}
            </Button>
          </form>
        )}
        <a href="/login" className="mt-6 block text-center text-sm font-medium text-ink-600 hover:text-ink-800">
          Voltar para o login
        </a>
      </div>
    </main>
  );
}
