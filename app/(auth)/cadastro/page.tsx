"use client";

// Cadastro do teste grátis SEM CARTÃO (0052). A conta nasce aqui: a função
// trial-signup reserva os 7 dias, cria o login com a senha escolhida (sem e-mail
// de confirmação) e o app entra direto, seguindo para o onboarding. No fim do
// teste, a dona assina no Mercado Pago com o mesmo e-mail.
// A landing pode mandar para cá com ?email=...&nome=... e as UTMs, que seguem para
// o funil do painel.
import { useEffect, useState } from "react";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TERMS_URL, PRIVACY_URL } from "@/lib/hive/access";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

async function startTrial(body: Record<string, unknown>) {
  const { error } = await createClient().functions.invoke("trial-signup", { body });
  if (!error) return { ok: true as const };
  const res = (error as { context?: Response }).context;
  let parsed: { error?: string; code?: string } | null = null;
  try { parsed = res ? await res.json() : null; } catch { parsed = null; }
  return {
    ok: false as const,
    exists: parsed?.code === "23505" || res?.status === 409,
    message: parsed?.error ?? "Não foi possível criar a conta agora. Confira a internet e tente de novo.",
  };
}

export default function CadastroPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [website, setWebsite] = useState(""); // campo escondido: só robôs preenchem
  const [utm, setUtm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setEmail(q.get("email") ?? "");
    setName(q.get("nome") ?? "");
    const u: Record<string, string> = {};
    for (const k of UTM_KEYS) { const v = q.get(k); if (v) u[k] = v.slice(0, 100); }
    setUtm(u);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setExists(false);
    if (password.length < 8) return setError("A senha precisa ter pelo menos 8 caracteres.");
    setLoading(true);
    const r = await startTrial({ name, email, password, utm, website });
    if (!r.ok) {
      setLoading(false);
      setExists(r.exists);
      return setError(r.message);
    }
    const { error: le } = await createClient().auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (le) {
      // A conta foi criada; só a entrada automática falhou.
      window.location.href = "/login";
      return;
    }
    window.location.href = "/onboarding";
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cream px-6 py-10">
      <div className="w-full max-w-sm surface-white rounded-lg border border-ink-100 bg-white p-8 dark:bg-surface">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Image src="/logo-lockup.png" alt="Sócia" width={260} height={81} priority className="h-auto w-[240px] dark:hidden" />
          <Image src="/logo-lockup-dark.png" alt="Sócia" width={260} height={81} className="h-auto w-[240px] hidden dark:block" />
          <h1 className="mt-2 font-serif text-xl font-medium text-ink-800">Teste grátis por 7 dias</h1>
          <p className="text-sm text-ink-500">Sem cartão de crédito. Depois, R$ 59,90 por mês, se quiser continuar.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Input label="Como você se chama?" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="E-mail" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input
            label="Crie uma senha"
            type="password"
            autoComplete="new-password"
            hint="Pelo menos 8 caracteres."
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>Site<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}{" "}
              {exists && <a href="/login" className="font-semibold underline">Entrar</a>}
            </p>
          )}
          <Button type="submit" variant="accent" loading={loading} className="w-full">
            {loading ? "Criando sua conta..." : "Começar meu teste grátis"}
          </Button>
          <p className="text-center text-xs text-ink-500">
            Ao criar a conta, você aceita os{" "}
            <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="underline">Termos de uso</a> e a{" "}
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline">Política de privacidade</a>.
          </p>
        </form>

        <a href="/login" className="mt-6 block text-center text-sm font-medium text-ink-600 hover:text-ink-800">
          Já tem conta? Entrar
        </a>
      </div>
    </main>
  );
}
