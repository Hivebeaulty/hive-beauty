"use client";

import { useState } from "react";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LANDING_URL } from "@/lib/hive/access";
import { safeNextPath } from "@/lib/hive/next-path";
import { LegalLinks } from "@/components/legal-links";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError("E-mail ou senha inválidos.");
      return;
    }
    // Volta para a página pedida antes do login (só caminhos deste site).
    window.location.href = safeNextPath(new URLSearchParams(window.location.search).get("next"));
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cream px-6">
      <div className="w-full max-w-sm rounded-lg border border-ink-100 bg-surface p-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Image src="/logo-lockup.png" alt="Áurea" width={220} height={138} priority className="h-auto w-[180px] dark:hidden" />
          <Image src="/logo-lockup-dark.png" alt="Áurea" width={220} height={138} className="h-auto w-[180px] hidden dark:block" />
          <p className="text-sm text-ink-400">Entre para administrar seu negócio.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="email"
            placeholder="E-mail"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            type="password"
            placeholder="Senha"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <a href="/esqueci-senha" className="-mt-1 block text-right text-xs font-medium text-ink-500 hover:text-ink-800">
            Esqueci minha senha
          </a>
          <Button type="submit" loading={loading} className="w-full">
            {loading ? "Entrando..." : "Entrar"}
          </Button>
        </form>

        <a href={LANDING_URL} className="mt-6 block text-center text-sm font-medium text-ink-600 hover:text-ink-800">
          Ainda não tem conta? Criar conta
        </a>
        <LegalLinks className="mt-6" />
      </div>
    </main>
  );
}
