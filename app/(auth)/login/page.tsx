"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
    window.location.href = "/inicio";
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-blush-100 px-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-bold text-plum-500">hive beauty</h1>
        <p className="mb-6 text-sm text-charcoal-700">Entre para administrar seu negócio.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="E-mail"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-blush-200 bg-blush-50 px-4 py-3 text-charcoal-900 outline-none focus:border-plum-500"
          />
          <input
            type="password"
            placeholder="Senha"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-blush-200 bg-blush-50 px-4 py-3 text-charcoal-900 outline-none focus:border-plum-500"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-plum-500 py-3 font-semibold text-white transition hover:bg-plum-600 disabled:opacity-60"
          >
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <a href="/cadastro" className="mt-6 block text-center text-sm text-plum-500">
          Ainda não tem conta? Criar conta
        </a>
      </div>
    </main>
  );
}
