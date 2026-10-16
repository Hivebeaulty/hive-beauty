// Recuperação de senha por e-mail (Supabase Auth). Lógica PURA.
//
// O e-mail de recuperação pode chegar em três formatos, conforme a configuração
// do modelo de e-mail no Supabase:
//   ?token_hash=...&type=recovery  → recomendado: funciona em QUALQUER aparelho
//   ?code=...                      → padrão PKCE: só no mesmo navegador do pedido
//   #error=...&error_description=  → link vencido/inválido
export const PASSWORD_MIN = 8;

export type RecoveryLink =
  | { kind: "token_hash"; tokenHash: string }
  | { kind: "code"; code: string }
  | { kind: "error"; message: string }
  | { kind: "none" };

export function parseRecoveryLink(search: string, hash: string): RecoveryLink {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const h = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const err = q.get("error_code") ?? h.get("error_code") ?? q.get("error") ?? h.get("error");
  if (err) {
    const expired = /expired|otp_expired/i.test(err + " " + (q.get("error_description") ?? h.get("error_description") ?? ""));
    return {
      kind: "error",
      message: expired
        ? "Este link expirou. Peça um novo link de recuperação."
        : "Este link não é válido. Peça um novo link de recuperação.",
    };
  }
  const tokenHash = q.get("token_hash");
  if (tokenHash && (q.get("type") ?? "recovery") === "recovery") return { kind: "token_hash", tokenHash };
  const code = q.get("code");
  if (code) return { kind: "code", code };
  return { kind: "none" };
}

/** Problema com a nova senha (null = pode salvar). */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`;
  if (password !== confirm) return "As duas senhas não são iguais.";
  return null;
}

/**
 * Mensagem depois de pedir o link. Por segurança, NUNCA diz se o e-mail existe:
 * a resposta é a mesma para e-mail cadastrado ou não. Só o excesso de pedidos
 * ganha mensagem própria.
 */
export function resetRequestMessage(error: { status?: number; code?: string; message?: string } | null): { ok: boolean; text: string } {
  if (error && (error.status === 429 || /rate limit|over_email_send_rate_limit/i.test(`${error.code} ${error.message}`))) {
    return { ok: false, text: "Muitos pedidos em pouco tempo. Aguarde alguns minutos e tente de novo." };
  }
  return { ok: true, text: "Se este e-mail estiver cadastrado, você vai receber um link para criar uma nova senha. Confira também a caixa de spam." };
}
