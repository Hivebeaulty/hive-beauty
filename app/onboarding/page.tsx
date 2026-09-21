"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
    <main className="flex min-h-screen flex-col justify-center bg-blush-100 px-6 py-10">
      <div className="mx-auto w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        {step === 1 && (
          <>
            <h2 className="mb-4 text-xl font-bold text-charcoal-900">Qual o nome da sua empresa?</h2>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Ex: Studio Bella"
              className="w-full rounded-xl border border-blush-200 bg-blush-50 px-4 py-3 outline-none focus:border-plum-500"
            />
            <button
              disabled={!companyName}
              onClick={() => setStep(2)}
              className="mt-6 w-full rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-40"
            >
              Continuar
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="mb-4 text-xl font-bold text-charcoal-900">Qual é o seu negócio?</h2>
            <div className="grid grid-cols-2 gap-2">
              {NICHOS.map((n) => (
                <button
                  key={n.slug}
                  onClick={() => setNiche(n.slug)}
                  className={`rounded-xl border px-3 py-3 text-sm font-medium transition ${
                    niche === n.slug
                      ? "border-plum-500 bg-plum-500 text-white"
                      : "border-blush-200 bg-blush-50 text-charcoal-900"
                  }`}
                >
                  {n.label}
                </button>
              ))}
            </div>
            <button
              disabled={!niche || loading}
              onClick={finish}
              className="mt-6 w-full rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-40"
            >
              {loading ? "Criando empresa..." : "Entrar no Hive Beauty"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
