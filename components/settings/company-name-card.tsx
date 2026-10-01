"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

// Dados da empresa: nome do negócio (companies.name — o único nome da
// empresa no sistema), telefone e e-mail (migration 0007).
export function CompanyNameCard({ companyId }: { companyId: string }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // false = a migration 0007 ainda não foi aplicada neste banco; a tela
  // continua funcionando só com o nome, em vez de quebrar.
  const [contactAvailable, setContactAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const full = await supabase.from("companies").select("name, phone, email").eq("id", companyId).single();
      if (!full.error) {
        setName(full.data?.name ?? "");
        setPhone(full.data?.phone ?? "");
        setEmail(full.data?.email ?? "");
      } else {
        setContactAvailable(false);
        const basic = await supabase.from("companies").select("name").eq("id", companyId).single();
        setName(basic.data?.name ?? "");
      }
      setLoading(false);
    })();
  }, [companyId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = contactAvailable
      ? { name: name.trim(), phone: phone.trim() || null, email: email.trim() || null }
      : { name: name.trim() };
    const { error } = await createClient().from("companies").update(payload).eq("id", companyId);
    setSaving(false);
    if (error) toast.error("Não foi possível salvar os dados da empresa.");
    else toast.success("Dados da empresa atualizados.");
  }

  return (
    <form onSubmit={handleSave} className="space-y-3 rounded-lg border border-ink-100 bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink-700">Dados da empresa</h2>
      <Input label="Nome do negócio" value={name} disabled={loading} onChange={(e) => setName(e.target.value)} />
      {contactAvailable && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Telefone / WhatsApp"
            type="tel"
            inputMode="tel"
            value={phone}
            disabled={loading}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(11) 99999-0000"
            hint="Número do negócio — será usado na integração com WhatsApp."
          />
          <Input
            label="E-mail"
            type="email"
            value={email}
            disabled={loading}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="contato@seunegocio.com"
          />
        </div>
      )}
      <Button type="submit" size="sm" loading={saving} disabled={loading || !name.trim()}>
        {saving ? "Salvando..." : "Salvar"}
      </Button>
    </form>
  );
}
