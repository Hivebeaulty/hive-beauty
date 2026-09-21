"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";

type ClientFormData = {
  id: string;
  name: string;
  phone: string;
  instagram: string;
  birth_date: string;
  preferences: string;
  notes: string;
};

export function ClienteForm({ initial }: { initial?: ClientFormData }) {
  const router = useRouter();
  const { companyId } = useCompany();
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [instagram, setInstagram] = useState(initial?.instagram ?? "");
  const [birthDate, setBirthDate] = useState(initial?.birth_date ?? "");
  const [preferences, setPreferences] = useState(initial?.preferences ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const supabase = createClient();

    const payload = {
      company_id: companyId,
      name,
      phone: phone || null,
      instagram: instagram || null,
      birth_date: birthDate || null,
      preferences: preferences || null,
      notes: notes || null,
    };

    const { data, error } = initial
      ? await supabase.from("clients").update(payload).eq("id", initial.id).select("id").single()
      : await supabase.from("clients").insert(payload).select("id").single();

    setSaving(false);
    if (error) {
      setError("Não foi possível salvar. Tente novamente.");
      return;
    }
    router.push(`/clientes/${data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Nome</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Telefone</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(11) 99999-0000"
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-charcoal-700">Instagram</label>
          <input
            value={instagram}
            onChange={(e) => setInstagram(e.target.value)}
            placeholder="@usuaria"
            className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Data de nascimento</label>
        <input
          type="date"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Preferências</label>
        <textarea
          value={preferences}
          onChange={(e) => setPreferences(e.target.value)}
          rows={2}
          placeholder="Ex: prefere tons neutros, sensível na cutícula..."
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-charcoal-700">Observações internas</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-xl border border-blush-200 bg-white px-4 py-3 outline-none focus:border-plum-500"
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-xl bg-plum-500 py-3 font-semibold text-white disabled:opacity-60"
      >
        {saving ? "Salvando..." : "Salvar cliente"}
      </button>
    </form>
  );
}
