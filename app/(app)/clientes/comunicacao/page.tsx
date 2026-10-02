"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCompany } from "@/components/company-provider";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonListItem } from "@/components/ui/skeleton";
import { loadClientRows, type ClientRow } from "@/lib/hive/clients-data";
import type { ClientSegment } from "@/lib/hive/relationship";
import {
  BLOCK_LABEL,
  MAX_MESSAGE_LENGTH,
  TEMPLATE_VARIABLES,
  displayPhone,
  findUnknownVariables,
  recipientBlock,
  renderTemplate,
  summarizeAudience,
  type RecipientBlock,
} from "@/lib/hive/communication";
import { cn } from "@/lib/utils";
import { ChevronLeft, Info, AlertCircle, MessageSquareText, ShieldCheck, Send } from "lucide-react";

const SEGMENTS: { value: ClientSegment; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "novas", label: "Novas" },
  { value: "recorrentes", label: "Recorrentes" },
  { value: "inativas", label: "Inativas" },
  { value: "fora_do_padrao", label: "Fora do padrão" },
  { value: "aniversariantes", label: "Aniversariantes" },
];

const BLOCK_TONE: Record<RecipientBlock, "danger" | "warning" | "neutral"> = {
  blocked: "danger",
  no_phone: "warning",
  invalid_phone: "warning",
  landline: "neutral",
  consent_unknown: "neutral",
};

const CHUNK = 100;

export default function ComunicacaoPage() {
  const { companyId, companyName } = useCompany();
  const toast = useToast();
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [segment, setSegment] = useState<ClientSegment>("todas");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

  const reload = useCallback(async () => {
    const { rows, failed } = await loadClientRows(createClient(), companyId);
    setClients(rows.filter((c) => !c.archived_at)); // arquivadas nunca entram
    setFailed(failed);
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const segmentCounts = useMemo(() => {
    const counts = new Map<ClientSegment, number>();
    for (const s of SEGMENTS) counts.set(s.value, clients.filter((c) => c.segments.includes(s.value)).length);
    return counts;
  }, [clients]);

  const members = useMemo(() => clients.filter((c) => c.segments.includes(segment)), [clients, segment]);

  const evaluated = useMemo(() => members.map((c) => ({ client: c, block: recipientBlock(c) })), [members]);
  const reachable = useMemo(() => evaluated.filter((e) => e.block === null).map((e) => e.client), [evaluated]);
  const notReached = useMemo(() => evaluated.filter((e) => e.block !== null), [evaluated]);
  const consentUnknown = useMemo(
    () => evaluated.filter((e) => e.block === "consent_unknown").map((e) => e.client),
    [evaluated]
  );
  const summary = useMemo(() => summarizeAudience(members), [members]);

  // Ao trocar de segmento (ou recarregar), todas as que PODEM receber vêm
  // marcadas; a usuária desmarca quem quiser tirar.
  useEffect(() => {
    setSelected(new Set(reachable.map((c) => c.id)));
  }, [reachable]);

  const selectedClients = useMemo(() => reachable.filter((c) => selected.has(c.id)), [reachable, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function insertVariable(key: string) {
    const token = `{${key}}`;
    const el = messageRef.current;
    const start = el?.selectionStart ?? message.length;
    const end = el?.selectionEnd ?? message.length;
    const next = message.slice(0, start) + token + message.slice(end);
    if (next.length > MAX_MESSAGE_LENGTH) return;
    setMessage(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function registerConsent() {
    setSavingConsent(true);
    const supabase = createClient();
    const ids = consentUnknown.map((c) => c.id);
    let failedChunk = false;
    let updated = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      // Só o status é enviado; quem/quando o banco registra sozinho, e a empresa
      // é conferida pela RLS — nenhum company_id vem do navegador.
      // `.eq("comm_status", "unknown")`: só vira "autorizou" quem AINDA está sem
      // informação no banco. Se alguém foi marcada "não quer receber" depois que
      // esta tela carregou, essa escolha nunca é sobrescrita.
      const { data, error } = await supabase
        .from("clients")
        .update({ comm_status: "allowed" })
        .in("id", ids.slice(i, i + CHUNK))
        .eq("comm_status", "unknown")
        .select("id");
      if (error) {
        failedChunk = true;
        break;
      }
      updated += data?.length ?? 0;
    }
    setSavingConsent(false);
    if (failedChunk) {
      toast.error("Não foi possível registrar para todas. Tente novamente.");
    } else if (updated < ids.length) {
      toast.info(`Autorização registrada para ${updated} de ${ids.length}. As demais já tinham mudado e foram mantidas.`);
    } else {
      toast.success(`Autorização registrada para ${updated} cliente${updated > 1 ? "s" : ""}.`);
    }
    setConsentOpen(false);
    setConsentChecked(false);
    await reload();
  }

  const previewClient = selectedClients[0] ?? null;
  const previewName = previewClient?.name ?? "Maria Silva";
  const previewText = renderTemplate(message, { clientName: previewName, companyName: companyName || "seu negócio" });
  const unknownVars = findUnknownVariables(message);

  return (
    <div className="space-y-6 pb-4">
      <Link href="/clientes" className="flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" />
        Clientes
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-ink-800 sm:text-2xl">Central de comunicação</h1>
        <p className="mt-0.5 text-sm text-ink-400">Prepare uma mensagem e veja quem a receberia.</p>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
        <Info className="mt-0.5 size-4 shrink-0 text-ink-400" />
        <span>
          Esta tela só prepara a mensagem e a lista. <strong className="font-semibold">Nada é enviado</strong> — o envio pelo
          WhatsApp ainda não está disponível.
        </span>
      </div>

      {loading ? (
        <div className="space-y-2">
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      ) : failed ? (
        <EmptyState
          icon={AlertCircle}
          title="Não foi possível carregar as clientes"
          description="Verifique sua conexão e tente novamente em instantes."
        />
      ) : (
        <>
          {/* 1 — Quem */}
          <section className="space-y-3">
            <StepTitle n={1} title="Quem vai receber" />
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {SEGMENTS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSegment(s.value)}
                  className={cn(
                    "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                    segment === s.value ? "bg-ink-800 text-cream" : "bg-ink-50 text-ink-600 hover:bg-ink-100"
                  )}
                >
                  {s.label} <span className="opacity-60">{segmentCounts.get(s.value) ?? 0}</span>
                </button>
              ))}
            </div>

            <Card padding="sm" className="space-y-1.5">
              <p className="text-sm text-ink-700">
                <span className="text-lg font-semibold text-ink-800">{selectedClients.length}</span>{" "}
                {selectedClients.length === 1 ? "cliente selecionada" : "clientes selecionadas"}{" "}
                <span className="text-ink-400">
                  de {summary.total} no segmento ({summary.reachable} podem receber)
                </span>
              </p>
              {notReached.length > 0 && (
                <p className="text-xs text-ink-400">
                  Fora da lista:{" "}
                  {[
                    summary.blocked > 0 && `${summary.blocked} não querem receber`,
                    summary.noPhone + summary.invalidPhone > 0 &&
                      `${summary.noPhone + summary.invalidPhone} sem telefone válido`,
                    summary.landline > 0 && `${summary.landline} com telefone fixo`,
                    summary.consentUnknown > 0 && `${summary.consentUnknown} sem autorização informada`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  .
                </p>
              )}
            </Card>

            {members.length === 0 ? (
              <EmptyState icon={MessageSquareText} title="Nenhuma cliente neste segmento" description="Escolha outro segmento acima." />
            ) : (
              <>
                {reachable.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Podem receber</p>
                      <div className="flex gap-3 text-xs font-medium text-ink-500">
                        <button onClick={() => setSelected(new Set(reachable.map((c) => c.id)))} className="hover:text-ink-800">
                          Selecionar todas
                        </button>
                        <button onClick={() => setSelected(new Set())} className="hover:text-ink-800">
                          Limpar
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      {reachable.map((c) => (
                        <label
                          key={c.id}
                          className="flex cursor-pointer items-center gap-3 rounded-lg border border-ink-100 bg-surface p-3"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(c.id)}
                            onChange={() => toggle(c.id)}
                            className="size-4 shrink-0 accent-ink-800"
                          />
                          <Avatar name={c.name} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink-800">{c.name}</p>
                            <p className="truncate text-xs text-ink-400">{displayPhone(c)}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {reachable.length === 0 && (
                  <EmptyState
                    icon={MessageSquareText}
                    title="Ninguém deste segmento pode receber agora"
                    description="Veja abaixo o motivo de cada cliente."
                  />
                )}

                {consentUnknown.length > 0 && (
                  <Card padding="sm" className="flex items-center gap-3">
                    <ShieldCheck className="size-5 shrink-0 text-ink-400" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink-800">
                        {consentUnknown.length} sem autorização informada
                      </p>
                      <p className="text-xs text-ink-400">Têm celular válido, mas ainda não registrou se aceitam mensagens.</p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        // Cada abertura exige uma NOVA confirmação (a caixa nunca vem marcada).
                        setConsentChecked(false);
                        setConsentOpen(true);
                      }}
                    >
                      Registrar
                    </Button>
                  </Card>
                )}

                {notReached.length > 0 && (
                  <details className="group rounded-lg border border-ink-100 bg-surface">
                    <summary className="cursor-pointer list-none px-3.5 py-3 text-sm font-medium text-ink-700">
                      Não serão alcançadas ({notReached.length})
                    </summary>
                    <div className="space-y-1 border-t border-ink-100 p-2">
                      {notReached.map(({ client: c, block }) => (
                        <Link
                          key={c.id}
                          href={`/clientes/${c.id}/editar`}
                          className="flex items-center gap-3 rounded-md p-2 hover:bg-ink-50"
                        >
                          <Avatar name={c.name} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink-800">{c.name}</p>
                            <p className="truncate text-xs text-ink-400">{displayPhone(c) ?? "Sem telefone"}</p>
                          </div>
                          <Badge tone={BLOCK_TONE[block!]} className="shrink-0">
                            {BLOCK_LABEL[block!]}
                          </Badge>
                        </Link>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </section>

          {/* 2 — Mensagem */}
          <section className="space-y-3">
            <StepTitle n={2} title="Mensagem" />
            <Textarea
              ref={messageRef}
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
              rows={5}
              placeholder="Oi {nome}! Faz um tempinho que não nos vemos. Que tal agendar um horário?"
              aria-label="Texto da mensagem"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-ink-400">Inserir:</span>
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => insertVariable(v.key)}
                    className="rounded-full border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-600 hover:bg-ink-50"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-ink-300">
                {message.length}/{MAX_MESSAGE_LENGTH}
              </span>
            </div>
            {unknownVars.length > 0 && (
              <p className="text-xs text-warning">
                Variável não reconhecida: {unknownVars.map((v) => `{${v}}`).join(", ")}. Ela será enviada como está.
              </p>
            )}
          </section>

          {/* 3 — Prévia */}
          <section className="space-y-3">
            <StepTitle n={3} title="Prévia" />
            <p className="text-xs text-ink-400">
              {previewClient ? (
                <>Como ficaria para {previewClient.name}.</>
              ) : (
                <>Exemplo com um nome fictício — selecione uma cliente para ver a real.</>
              )}
            </p>
            <div className="rounded-lg bg-ink-50 p-4">
              {message.trim() ? (
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-tl-sm border border-ink-100 bg-surface px-3.5 py-2.5 text-sm text-ink-800">
                  {previewText}
                </div>
              ) : (
                <p className="text-sm text-ink-300">Escreva a mensagem para ver a prévia.</p>
              )}
            </div>

            <div className="space-y-2 pt-1">
              <Button className="w-full" disabled aria-describedby="envio-indisponivel">
                <Send className="size-4" />
                Enviar para {selectedClients.length} cliente{selectedClients.length === 1 ? "" : "s"}
              </Button>
              <p id="envio-indisponivel" className="text-center text-xs text-ink-400">
                Envio indisponível por enquanto. Quando o WhatsApp do seu negócio for conectado, você poderá enviar daqui.
              </p>
            </div>
          </section>
        </>
      )}

      <Modal open={consentOpen} onClose={() => !savingConsent && setConsentOpen(false)} title="Registrar autorização">
        <div className="space-y-4">
          <p className="text-sm text-ink-700">
            Você vai registrar que <strong className="font-semibold">{consentUnknown.length}</strong>{" "}
            cliente{consentUnknown.length > 1 ? "s" : ""} aceitaram receber mensagens do seu negócio.
          </p>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-ink-200 p-3 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-ink-800"
            />
            <span>Confirmo que elas concordaram em receber mensagens. Posso corrigir isso depois, cliente por cliente.</span>
          </label>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setConsentOpen(false)} disabled={savingConsent}>
              Cancelar
            </Button>
            <Button className="flex-1" onClick={registerConsent} disabled={!consentChecked} loading={savingConsent}>
              Registrar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function StepTitle({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-800">
      <span className="flex size-5 items-center justify-center rounded-full bg-ink-800 text-[11px] font-semibold text-cream">
        {n}
      </span>
      {title}
    </h2>
  );
}
