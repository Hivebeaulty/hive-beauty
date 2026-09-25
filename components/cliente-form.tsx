"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

type ClientFormData = {
  id: string;
  name: string;
  phone: string;
  instagram: string;
  birth_date: string;
  preferences: string;
  notes: string;
};

// Mesmos campos e mesma lógica de sempre (insert/update na tabela clients,
// redireciona pro perfil) — só migrado pros componentes do Design System.
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
      <Input label="Nome" required value={name} onChange={(e) => setName(e.target.value)} />

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Telefone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(11) 99999-0000"
        />
        <Input
          label="Instagram"
          value={instagram}
          onChange={(e) => setInstagram(e.target.value)}
          placeholder="@usuaria"
        />
      </div>

      <Input
        type="date"
        label="Data de nascimento"
        value={birthDate}
        onChange={(e) => setBirthDate(e.target.value)}
      />

      <Textarea
        label="Preferências"
        value={preferences}
        onChange={(e) => setPreferences(e.target.value)}
        rows={2}
        placeholder="Ex: prefere tons neutros, sensível na cutícula..."
      />

      <Textarea
        label="Observações internas"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <Button type="submit" loading={saving} className="w-full">
        {saving ? "Salvando..." : "Salvar cliente"}
      </Button>
    </form>
  );
}
