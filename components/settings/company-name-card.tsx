"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export function CompanyNameCard({ companyId }: { companyId: string }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    createClient()
      .from("companies")
      .select("name")
      .eq("id", companyId)
      .single()
      .then(({ data }) => {
        setName(data?.name ?? "");
        setLoading(false);
      });
  }, [companyId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await createClient().from("companies").update({ name }).eq("id", companyId);
    setSaving(false);
    if (error) toast.error("Não foi possível salvar o nome da empresa.");
    else toast.success("Nome da empresa atualizado.");
  }

  return (
    <form onSubmit={handleSave} className="space-y-3 rounded-lg border border-ink-100 bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink-700">Dados da empresa</h2>
      <Input
        label="Nome da empresa"
        value={name}
        disabled={loading}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit" size="sm" loading={saving} disabled={loading || !name.trim()}>
        {saving ? "Salvando..." : "Salvar"}
      </Button>
    </form>
  );
}
