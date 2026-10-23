"use client";

// Envia para a cliente a lista dos próximos atendimentos (ficha da cliente).
// Dois caminhos, como no resto do app:
//   1) WhatsApp do negócio conectado -> fila da Áurea (wa_send_message, 0017).
//      O BANCO decide: papel, cliente bloqueada/arquivada/sem celular, sessão
//      conectada, limite por minuto/dia e idempotência pela chave.
//   2) Sem conexão -> abre o WhatsApp da profissional (wa.me) com o texto pronto.
// Cliente que pediu para não receber mensagens: nenhum envio é oferecido.
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { parseStatus } from "@/lib/hive/whatsapp";
import { whatsappLink } from "@/lib/hive/format";
import { buildUpcomingMessage, sendErrorMessage, upcomingSendKey, type UpcomingItem } from "@/lib/hive/upcoming-message";
import { Send, MessageCircle, AlertCircle } from "lucide-react";

type Channel = "loading" | "queue" | "manual";

export function ClienteProximosEnviar({
  clientId,
  companyId,
  clientName,
  phone,
  phoneNormalized,
  blocked,
  items,
}: {
  clientId: string;
  companyId: string;
  clientName: string;
  phone: string | null;
  phoneNormalized: string | null;
  blocked: boolean;
  items: UpcomingItem[];
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<Channel>("loading");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waUrl = whatsappLink(phone, phoneNormalized, text);
  const canReach = !!whatsappLink(phone, phoneNormalized);

  async function openModal() {
    setText(buildUpcomingMessage({ clientName, items }));
    setError(null);
    setChannel("loading");
    setOpen(true);
    try {
      const { data, error: e } = await createClient().rpc("wa_get_status", { p_company_id: companyId });
      const st = e ? null : parseStatus(data);
      setChannel(st?.status === "connected" && st.canSend ? "queue" : "manual");
    } catch {
      setChannel("manual");
    }
  }

  async function sendQueue() {
    const body = text.trim();
    if (!body) return setError("A mensagem está vazia.");
    setSending(true);
    setError(null);
    const { data, error: e } = await createClient().rpc("wa_send_message", {
      p_client_id: clientId,
      p_body: body,
      p_idempotency_key: upcomingSendKey(clientId, body),
    });
    setSending(false);
    if (e) {
      if (e.code === "AUW01") setChannel("manual"); // desconectou: oferece o wa.me
      return setError(sendErrorMessage(e.code, (e as { details?: string }).details));
    }
    const created = (data as { created?: boolean } | null)?.created !== false;
    toast.success(created ? `Mensagem enviada para ${clientName}.` : "Essa mesma mensagem já foi enviada hoje.");
    setOpen(false);
  }

  if (blocked) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-400">
        <AlertCircle className="size-3.5 shrink-0" /> Ela pediu para não receber mensagens.
      </p>
    );
  }
  if (!canReach) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-400">
        <AlertCircle className="size-3.5 shrink-0" /> Sem celular válido para WhatsApp.
      </p>
    );
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={openModal}>
        <Send className="size-4" />
        Enviar para a cliente
      </Button>

      <Modal open={open} onClose={() => !sending && setOpen(false)} title="Enviar próximos atendimentos">
        <div className="space-y-4">
          <Textarea
            label="Mensagem"
            hint="Você pode ajustar o texto antes de enviar."
            rows={Math.min(14, text.split("\n").length + 1)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4096}
          />

          {error && (
            <p role="alert" className="flex items-start gap-1.5 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            {channel === "queue" && (
              <Button onClick={sendQueue} disabled={sending || !text.trim()} className="sm:flex-1">
                <Send className="size-4" />
                {sending ? "Enviando…" : "Enviar pelo WhatsApp do negócio"}
              </Button>
            )}
            {channel !== "loading" && waUrl && (
              <a
                href={waUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={
                  channel === "manual"
                    ? "btn-gold flex h-10 items-center justify-center gap-2 rounded px-4 text-sm font-semibold sm:flex-1"
                    : "flex h-10 items-center justify-center gap-2 rounded border border-ink-200 bg-surface px-4 text-sm font-semibold text-ink-800 hover:bg-ink-50 sm:flex-1"
                }
              >
                <MessageCircle className="size-4" />
                Abrir no meu WhatsApp
              </a>
            )}
            {channel === "loading" && <p className="text-sm text-ink-400">Verificando o WhatsApp do negócio…</p>}
          </div>
        </div>
      </Modal>
    </>
  );
}
