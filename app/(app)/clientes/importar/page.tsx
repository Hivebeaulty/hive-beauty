"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { contactsFromCSV, type ImportedContact } from "@/lib/hive/csv";
import { parseBrazilPhone, formatBrazilPhone } from "@/lib/hive/phone";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { ChevronLeft, Smartphone, FileUp, Download, AlertTriangle } from "lucide-react";

// phoneState: "none" = contato sem telefone; "invalid" = tem texto, mas não é um
// número brasileiro válido (não vem marcado para importar); "ok" = válido.
type Row = ImportedContact & {
  selected: boolean;
  isDuplicate: boolean;
  phoneState: "none" | "ok" | "invalid";
  normalized: string | null;
};

// API real do navegador (Contact Picker), NÃO uma simulação. Hoje só existe
// no Chrome/Edge Android — não no iOS Safari, nem em navegador desktop.
// Detecção em runtime: o botão de "importar do aparelho" só aparece onde a
// API realmente existe, em vez de mostrar um botão que falha em produção.
function isContactPickerAvailable() {
  return typeof navigator !== "undefined" && "contacts" in navigator && "ContactsManager" in window;
}

const MODEL_CSV = "nome,telefone,aniversario\nMaria Silva,11999990000,15/03/1990\nJoana Souza,11988887777,\n";

export default function ImportarClientesPage() {
  const router = useRouter();
  const toast = useToast();
  const { companyId } = useCompany();
  const fileRef = useRef<HTMLInputElement>(null);

  const [pickerAvailable, setPickerAvailable] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [existingPhones, setExistingPhones] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPickerAvailable(isContactPickerAvailable());
    createClient()
      .from("clients")
      .select("phone_normalized")
      .eq("company_id", companyId)
      .then(({ data }) => {
        // Compara pelo número NORMALIZADO (calculado pelo banco): "(11) 99999-0000",
        // "11999990000" e "+55 11 99999-0000" são o mesmo número.
        setExistingPhones(
          new Set((data ?? []).map((c) => c.phone_normalized as string | null).filter((n): n is string => !!n))
        );
      });
  }, [companyId]);

  function buildRows(contacts: ImportedContact[]) {
    const seen = new Set<string>();
    const next: Row[] = [];
    for (const c of contacts) {
      const parsed = c.phone.trim() ? parseBrazilPhone(c.phone) : null;
      const normalized = parsed?.ok ? parsed.normalized : null;
      const phoneState: Row["phoneState"] = !parsed ? "none" : parsed.ok ? "ok" : "invalid";
      const isDuplicate = !!normalized && (existingPhones.has(normalized) || seen.has(normalized));
      if (normalized) seen.add(normalized);
      next.push({
        ...c,
        isDuplicate,
        phoneState,
        normalized,
        selected: c.name.trim().length > 0 && !isDuplicate && phoneState !== "invalid",
      });
    }
    setRows(next);
  }

  async function handleDevicePicker() {
    try {
      // @ts-expect-error -- Contact Picker API ainda não tem tipos oficiais no TypeScript/DOM lib.
      const selected = await navigator.contacts.select(["name", "tel"], { multiple: true });
      const contacts: ImportedContact[] = selected.map((p: { name?: string[]; tel?: string[] }) => ({
        name: p.name?.[0] ?? "",
        phone: p.tel?.[0] ?? "",
        // A API do navegador não expõe aniversário — não é limitação nossa.
        birthDate: null,
      }));
      if (contacts.length === 0) return;
      buildRows(contacts);
    } catch {
      // Usuária cancelou o seletor do sistema — não é um erro pra mostrar.
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const contacts = contactsFromCSV(String(reader.result));
      if (contacts.length === 0) {
        toast.error("Não encontrei contatos nesse arquivo. Confira o formato (veja o modelo).");
        return;
      }
      buildRows(contacts);
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  }

  function downloadModel() {
    const blob = new Blob([MODEL_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modelo-clientes.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function toggleRow(i: number) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, selected: !r.selected } : r)));
  }

  async function handleImport() {
    const toImport = rows.filter((r) => r.selected && r.name.trim());
    if (toImport.length === 0) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from("clients").insert(
      toImport.map((r) => ({
        company_id: companyId,
        name: r.name.trim(),
        // Número válido é gravado no formato amigável; o que não for número
        // (só se a usuária marcou à mão) é gravado como veio, sem perder nada.
        phone: r.phoneState === "ok" ? formatBrazilPhone(r.phone) : r.phone.trim() || null,
        birth_date: r.birthDate,
        // Importar um contato NÃO significa que ela aceitou receber mensagens.
        comm_status: "unknown",
        comm_status_source: "import",
      }))
    );
    setSaving(false);
    if (error) {
      toast.error("Não foi possível importar. Tente novamente.");
      return;
    }
    toast.success(`${toImport.length} cliente${toImport.length > 1 ? "s" : ""} importada${toImport.length > 1 ? "s" : ""}.`);
    router.push("/clientes");
    router.refresh();
  }

  const selectedCount = rows.filter((r) => r.selected).length;

  return (
    <div className="space-y-5 pb-4">
      <Link href="/clientes" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Clientes
      </Link>
      <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Importar clientes</h1>

      {rows.length === 0 ? (
        <div className="space-y-3">
          {pickerAvailable && (
            <Card interactive onClick={handleDevicePicker} className="flex cursor-pointer items-center gap-3">
              <Smartphone className="size-5 shrink-0 text-ink-400" />
              <div className="flex-1">
                <p className="font-medium text-ink-800">Importar do aparelho</p>
                <p className="text-xs text-ink-400">Escolha contatos direto da agenda do celular.</p>
              </div>
            </Card>
          )}

          <Card
            interactive
            onClick={() => fileRef.current?.click()}
            className="flex cursor-pointer items-center gap-3"
          >
            <FileUp className="size-5 shrink-0 text-ink-400" />
            <div className="flex-1">
              <p className="font-medium text-ink-800">Importar arquivo (CSV)</p>
              <p className="text-xs text-ink-400">
                {pickerAvailable
                  ? "Funciona em qualquer aparelho, inclusive iPhone."
                  : "Seu navegador não permite importar direto do aparelho — essa opção funciona em qualquer um."}
              </p>
            </div>
          </Card>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />

          <button
            onClick={downloadModel}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-400 hover:text-ink-700"
          >
            <Download className="size-3.5" />
            Baixar modelo de CSV
          </button>

          {!pickerAvailable && (
            <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-xs text-ink-500">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ink-400" />
              <span>
                A importação direta da agenda do celular só existe hoje no Chrome/Edge no Android — o iPhone e a
                maioria dos navegadores não oferecem essa permissão para sites. O arquivo CSV funciona em qualquer
                aparelho.
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-400">
            {rows.length} contato{rows.length > 1 ? "s" : ""} encontrado{rows.length > 1 ? "s" : ""} — revise antes de
            importar.
          </p>
          <div className="space-y-1.5">
            {rows.map((r, i) => (
              <label
                key={i}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-ink-100 bg-surface p-3"
              >
                <input
                  type="checkbox"
                  checked={r.selected}
                  onChange={() => toggleRow(i)}
                  className="size-4 shrink-0 accent-ink-800"
                />
                <Avatar name={r.name || "?"} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-800">{r.name || "(sem nome)"}</p>
                  <p className="truncate text-xs text-ink-400">
                    {r.phoneState === "ok" ? formatBrazilPhone(r.phone) : r.phone || "sem telefone"}
                  </p>
                </div>
                {r.phoneState === "invalid" && (
                  <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                    telefone inválido
                  </span>
                )}
                {r.isDuplicate && (
                  <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-semibold text-ink-500">
                    já existe
                  </span>
                )}
              </label>
            ))}
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={() => setRows([])} className="flex-1">
              Cancelar
            </Button>
            <Button onClick={handleImport} loading={saving} disabled={selectedCount === 0} className="flex-1">
              {saving ? "Importando..." : `Importar ${selectedCount || ""}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
