"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { parseBrazilPhone, formatBrazilPhone } from "@/lib/hive/phone";
import type { CommStatus } from "@/lib/hive/communication";
import { AlertTriangle } from "lucide-react";

type ClientFormData = {
  id: string;
  name: string;
  phone: string;
  instagram: string;
  birth_date: string;
  preferences: string;
  notes: string;
  comm_status: CommStatus;
};

type DuplicateHit = { id: string; name: string; archived: boolean };

const COMM_OPTIONS: { value: CommStatus; label: string }[] = [
  { value: "unknown", label: "Não informada" },
  { value: "allowed", label: "Autorizou" },
  { value: "blocked", label: "Não quer receber" },
];

const COMM_HINT: Record<CommStatus, string> = {
  unknown: "Ainda não perguntei se ela aceita receber mensagens. Ela não entra em envios.",
  allowed: "Ela concordou em receber mensagens do seu negócio.",
  blocked: "Ela pediu para não receber mensagens. Respeitamos isso em qualquer envio.",
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
  const [commStatus, setCommStatus] = useState<CommStatus>(initial?.comm_status ?? "unknown");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateHit | null>(null);

  const phoneChanged = phone.trim() !== (initial?.phone ?? "").trim();

  // Ao sair do campo: se o número é válido, mostra no formato amigável; se não,
  // avisa já (em vez de só na hora de salvar).
  function handlePhoneBlur() {
    const value = phone.trim();
    if (!value) {
      setPhoneError(null);
      return;
    }
    const parsed = parseBrazilPhone(value);
    if (parsed.ok) {
      setPhone(formatBrazilPhone(value));
      setPhoneError(null);
    } else if (phoneChanged) {
      setPhoneError(parsed.message);
    }
  }

  async function save(skipDuplicateCheck: boolean) {
    setError(null);
    const phoneValue = phone.trim();
    const parsed = phoneValue ? parseBrazilPhone(phoneValue) : null;

    // Telefone antigo já gravado (mesmo que fora do padrão) não impede editar
    // outros dados da cliente; só validamos quando a usuária o alterou.
    if (parsed && !parsed.ok && phoneChanged) {
      setPhoneError(parsed.message);
      return;
    }

    setSaving(true);
    const supabase = createClient();

    // Duplicidade: mesmo número em outro formato ("(11) 99999-0000" = "11999990000").
    // Aviso, não bloqueio: mãe e filha podem dividir o número.
    if (!skipDuplicateCheck && parsed?.ok && (phoneChanged || !initial)) {
      let q = supabase
        .from("clients")
        .select("id, name, archived_at")
        .eq("company_id", companyId)
        .eq("phone_normalized", parsed.normalized)
        .limit(1);
      if (initial) q = q.neq("id", initial.id);
      const { data: hits } = await q;
      if (hits && hits.length > 0) {
        setDuplicate({ id: hits[0].id, name: hits[0].name, archived: !!hits[0].archived_at });
        setSaving(false);
        return;
      }
    }

    const common = {
      name: name.trim(),
      phone: phoneValue ? (phoneChanged && parsed?.ok ? formatBrazilPhone(phoneValue) : phoneValue) : null,
      instagram: instagram || null,
      birth_date: birthDate || null,
      preferences: preferences || null,
      notes: notes || null,
    };

    // company_id só vai no INSERT (a RLS confere que a usuária pertence a ela).
    // No UPDATE a empresa da cliente nunca é reenviada pelo navegador.
    //
    // Consentimento: no UPDATE só é enviado se a usuária MUDOU o campo. Reenviar
    // o valor que o formulário carregou sobrescreveria, sem ninguém perceber, uma
    // alteração feita enquanto a tela estava aberta (ex.: um opt-out da cliente).
    const consentChanged = !initial || commStatus !== initial.comm_status;
    const payload = consentChanged ? { ...common, comm_status: commStatus } : common;

    const { data, error } = initial
      ? await supabase.from("clients").update(payload).eq("id", initial.id).select("id").single()
      : await supabase.from("clients").insert({ ...payload, company_id: companyId }).select("id").single();

    setSaving(false);
    if (error) {
      setError("Não foi possível salvar. Tente novamente.");
      return;
    }
    router.push(`/clientes/${data.id}`);
    router.refresh();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void save(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input label="Nome" required value={name} onChange={(e) => setName(e.target.value)} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Telefone (WhatsApp)"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setPhoneError(null);
            setDuplicate(null);
          }}
          onBlur={handlePhoneBlur}
          placeholder="(11) 99999-0000"
          error={phoneError ?? undefined}
          hint={!phoneError ? "Com DDD. Pode digitar de qualquer jeito, nós organizamos." : undefined}
        />
        <Input
          label="Instagram"
          value={instagram}
          onChange={(e) => setInstagram(e.target.value)}
          placeholder="@usuaria"
        />
      </div>

      {duplicate && (
        <div className="flex items-start gap-2.5 rounded-lg border border-gold-300 bg-gold-50 px-4 py-3 text-sm text-ink-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-gold-700" />
          <div className="space-y-2">
            <p>
              Este número já está cadastrado em{" "}
              <Link href={`/clientes/${duplicate.id}`} className="font-semibold underline underline-offset-2">
                {duplicate.name}
              </Link>
              {duplicate.archived && " (arquivada)"}.
            </p>
            <Button type="button" variant="secondary" size="sm" loading={saving} onClick={() => void save(true)}>
              Salvar mesmo assim
            </Button>
          </div>
        </div>
      )}

      <Input
        type="date"
        label="Data de nascimento"
        value={birthDate}
        onChange={(e) => setBirthDate(e.target.value)}
      />

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-ink-700">Mensagens pelo WhatsApp</p>
        <SegmentedControl value={commStatus} onChange={setCommStatus} options={COMM_OPTIONS} className="w-full [&>button]:flex-1 [&>button]:px-2" />
        <p className="text-xs text-ink-400">{COMM_HINT[commStatus]}</p>
      </div>

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

      <Button type="submit" loading={saving && !duplicate} className="w-full">
        {saving && !duplicate ? "Salvando..." : "Salvar cliente"}
      </Button>
    </form>
  );
}
