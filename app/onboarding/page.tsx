"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NICHOS = [
  { slug: "nail_designer", label: "Nail Designer" },
  { slug: "lash_designer", label: "Lash Designer" },
  { slug: "sobrancelhas", label: "Sobrancelhas" },
  { slug: "estetica", label: "Estética" },
  { slug: "laser", label: "Laser" },
  { slug: "salao", label: "Salão de Beleza" },
  { slug: "maquiagem", label: "Maquiagem" },
  { slug: "cabeleireiro", label: "Cabeleireiro" },
  { slug: "outro", label: "Outro" },
];

// Etapas 2 a 4 do onboarding (nome da empresa, nicho, sozinha/equipe).
// Etapas 5-6 (serviços e horário) entram na Fase 2, junto do módulo de Serviços.
export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState("");
  const [niche, setNiche] = useState("");
  const [loading, setLoading] = useState(false);

  async function finish() {
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("create_company_with_owner", {
      company_name: companyName,
      niche_slug: niche,
    });
    setLoading(false);
    if (!error) window.location.href = "/inicio";
  }

  return (
    <main className="flex min-h-screen flex-col justify-center bg-cream px-6 py-10">
      <div className="mx-auto w-full max-w-sm rounded-lg border border-ink-100 bg-surface p-8">
        {step === 1 && (
          <>
            <h2 className="mb-4 text-xl font-semibold text-ink-800">Qual o nome da sua empresa?</h2>
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Ex: Studio Bella"
            />
            <Button disabled={!companyName} onClick={() => setStep(2)} className="mt-6 w-full">
              Continuar
            </Button>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="mb-4 text-xl font-semibold text-ink-800">Qual é o seu negócio?</h2>
            <div className="grid grid-cols-2 gap-2">
              {NICHOS.map((n) => (
                <button
                  key={n.slug}
                  onClick={() => setNiche(n.slug)}
                  className={cn(
                    "rounded border px-3 py-3 text-sm font-medium transition-colors",
                    niche === n.slug
                      ? "border-ink-800 bg-ink-800 text-cream"
                      : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-50"
                  )}
                >
                  {n.label}
                </button>
              ))}
            </div>
            <Button disabled={!niche} loading={loading} onClick={finish} className="mt-6 w-full">
              {loading ? "Criando empresa..." : "Entrar na Áurea"}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
