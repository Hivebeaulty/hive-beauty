// Para onde voltar depois do login (?next=). Aceita SÓ caminhos deste próprio
// site: começa com uma "/" e não com "//" nem "/\" (que o navegador trataria
// como outro domínio), sem esquema ("https:", "javascript:"), sem caracteres de
// controle. Telas de autenticação não servem de destino (evita voltar ao login).
// Qualquer coisa fora disso -> /inicio.
const AUTH = ["/login", "/cadastro", "/esqueci-senha", "/redefinir-senha"];

export function safeNextPath(raw: string | null | undefined, fallback = "/inicio"): string {
  if (!raw || raw.length > 512) return fallback;
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  // eslint-disable-next-line no-control-regex
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || /[\u0000-\u001f\\]/.test(v) || /^\/[^?#]*:/.test(v)) {
    return fallback;
  }
  const path = v.split(/[?#]/)[0];
  if (AUTH.some((a) => path === a || path.startsWith(`${a}/`))) return fallback;
  return v;
}

/** Valor do ?next= para o middleware: só quando há para onde voltar além do início. */
export function nextParamFor(pathname: string, search: string): string | null {
  if (!pathname || pathname === "/" || pathname === "/inicio") return null;
  const target = `${pathname}${search}`;
  return safeNextPath(target, "") || null;
}
