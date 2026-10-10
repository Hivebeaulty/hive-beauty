"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { firstName } from "@/lib/hive/format";
import { DISPLAY_NAME_MAX, normalizeDisplayNameInput } from "@/lib/hive/display-name";

// "Como você quer ser chamada?" — profiles.display_name (migration 0013).
// Pessoal: vale para QUALQUER papel (cada uma edita só o próprio perfil, pela
// policy profiles_self_update). NÃO substitui o nome cadastrado: vazio = o app
// continua usando o nome do cadastro, como sempre foi.
export function ProfileNameCard() {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [fullName, setFullName] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  // false = a migration 0013 ainda não foi aplicada: o card some, nada quebra.
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id ?? null;
      setUserId(uid);
      if (!uid) {
        setLoading(false);
        return;
      }
      const { data, error } = await supabase.from("profiles").select("display_name, full_name").eq("id", uid).maybeSingle();
      if (error) {
        setAvailable(false);
      } else {
        setValue(data?.display_name ?? "");
        setFullName(data?.full_name ?? (auth.user?.user_metadata?.full_name as string | undefined) ?? null);
      }
      setLoading(false);
    })();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;
    setSaving(true);
    const normalized = normalizeDisplayNameInput(value);
    // .select("id"): a RLS pode filtrar sem erro; só é sucesso se 1 linha mudou.
    const { data, error } = await createClient()
      .from("profiles")
      .update({ display_name: normalized })
      .eq("id", userId)
      .select("id");
    setSaving(false);
    if (error || !data || data.length === 0) {
      toast.error("Não foi possível salvar seu nome. Tente novamente.");
      return;
    }
    setValue(normalized ?? "");
    toast.success(normalized ? `Pronto! Vou te chamar de ${normalized}.` : "Voltei a usar o nome do seu cadastro.");
  }

  if (!available) return null;

  const registered = fullName ? firstName(fullName) : null;

  return (
    <form onSubmit={handleSave} className="space-y-3 rounded-lg border border-ink-100 bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink-700">Seu nome</h2>
      <Input
        label="Como você quer ser chamada?"
        value={value}
        disabled={loading}
        maxLength={DISPLAY_NAME_MAX}
        onChange={(e) => setValue(e.target.value)}
        placeholder={registered ?? "Ex.: Paty"}
        hint={
          fullName
            ? `Aparece na saudação da tela inicial e nas mensagens para suas clientes. Seu nome de cadastro (${fullName}) não muda.`
            : "Aparece na saudação da tela inicial e nas mensagens para suas clientes."
        }
      />
      <Button type="submit" size="sm" loading={saving} disabled={loading}>
        {saving ? "Salvando..." : "Salvar"}
      </Button>
    </form>
  );
}
