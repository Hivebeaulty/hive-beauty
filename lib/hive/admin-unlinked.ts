// ---------------------------------------------------------------------------
// SuperAdmin — assinaturas sem dona (0045). Regras PURAS.
// O Mercado Pago não informou o e-mail e nada correspondeu: a cliente pagou e está
// sem acesso. Ligar a um e-mail faz a mp-sync criar a conta no próximo ciclo (≤ 5 min).
// ---------------------------------------------------------------------------

export type UnlinkedRow = {
  preapproval_id: string;
  mp_status: string | null;
  amount: number | null;
  date_created: string | null;
  first_seen: string;
  linked_email: string | null;
  linked_at: string | null;
};

/** Falha FECHADA: formato inesperado -> lista vazia não é aceita; devolve null. */
export function parseUnlinked(data: unknown): UnlinkedRow[] | null {
  if (!Array.isArray(data)) return null;
  const out: UnlinkedRow[] = [];
  for (const r of data as Record<string, unknown>[]) {
    if (!r || typeof r.preapproval_id !== "string" || typeof r.first_seen !== "string") return null;
    const amount = r.amount == null ? null : Number(r.amount);
    out.push({
      preapproval_id: r.preapproval_id,
      mp_status: typeof r.mp_status === "string" ? r.mp_status : null,
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
      date_created: typeof r.date_created === "string" ? r.date_created : null,
      first_seen: r.first_seen,
      linked_email: typeof r.linked_email === "string" ? r.linked_email : null,
      linked_at: typeof r.linked_at === "string" ? r.linked_at : null,
    });
  }
  return out;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Valida o formulário antes de chamar o banco. Devolve a mensagem de erro ou null. */
export function validateLink(email: string, reason: string): string | null {
  if (!EMAIL_RE.test(email.trim())) return "Confira o e-mail digitado.";
  const r = reason.trim();
  if (r.length < 5) return "Escreva o motivo (pelo menos 5 caracteres).";
  if (r.length > 500) return "O motivo pode ter até 500 caracteres.";
  return null;
}

/** Mensagem para a superadmin a partir do erro do banco. */
export function linkError(err: { code?: string; message?: string } | null): string {
  if (!err) return "";
  if (err.code === "AUA01") return "Confirme a verificação em duas etapas e tente de novo.";
  if (err.code === "42501") return "Sem permissão para esta ação.";
  if (err.code === "P0002") return "Essa assinatura já foi resolvida. Recarregue a página.";
  if (err.code === "22023") return err.message ?? "Confira os dados.";
  return "Não foi possível ligar a assinatura. Tente de novo.";
}

export const MP_STATUS_LABEL: Record<string, string> = {
  authorized: "Ativa no Mercado Pago",
  paused: "Pausada",
  cancelled: "Cancelada",
  pending: "Pendente",
};
