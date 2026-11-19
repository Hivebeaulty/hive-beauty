// admin-courtesy — cortesia com prazo (0054), oferecida SÓ pela dona, no painel SuperAdmin.
//   POST { action: "grant",  email, name?, days, origin, reason }  -> cria a cortesia e, se o e-mail ainda
//                                                                    não tem conta, cria o login e envia o
//                                                                    e-mail de "criar senha"
//   POST { action: "invite", email }                                -> (re)envia o e-mail de criar senha
//                                                                    para uma cortesia ativa
//
// Publicar COM verificação de JWT (padrão). Autorização em duas camadas, como a admin-billing:
//   1) o Supabase só deixa chegar aqui com JWT válido;
//   2) a cortesia é criada por admin_courtesy_grant chamada com a SESSÃO da usuária: o banco exige
//      superadmin + verificação em duas etapas (aal2) e grava a auditoria.
// Só depois disso a função usa a service role, e apenas para criar o login e mandar o e-mail
// (a parceira NÃO se cadastra sozinha: o e-mail é o que a dona digitou). Sem segredo no navegador.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = "https://hive-beauty.vercel.app";
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Só o app (produção e previews da Vercel deste projeto) chama esta função pelo navegador.
const ORIGIN_OK = /^https:\/\/hive-beauty(-[a-z0-9-]+)?\.vercel\.app$/;
function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGIN_OK.test(o) ? o : APP_URL,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
const json = (req: Request, status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "admin-courtesy", ...o }));
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");

type Account = { ok: true; created: boolean; emailSent: boolean } | { ok: false; detail: string };

/** Garante o login (já confirmado) e envia o e-mail de criar senha. Quem já tem login mantém a senha. */
export async function ensureAccountAndInvite(email: string, name: string | null, sendIfExists: boolean): Promise<Account> {
  const created = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    ...(name ? { user_metadata: { full_name: name } } : {}),
  });
  let isNew = true;
  if (created.error) {
    // 422 = e-mail já cadastrado: conta existente, não mexe na senha dela.
    if (created.error.status !== 422) return { ok: false, detail: created.error.message };
    isNew = false;
  }
  if (!isNew && !sendIfExists) return { ok: true, created: false, emailSent: false };
  const sent = await service.auth.resetPasswordForEmail(email, { redirectTo: `${APP_URL}/redefinir-senha` });
  return { ok: true, created: isNew, emailSent: !sent.error };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Método não permitido." });
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(req, 401, { error: "Não autenticado." });

  // Cliente com a sessão da usuária: o banco decide (superadmin + MFA) e audita.
  const user = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const body = await req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json(req, 400, { error: "E-mail inválido." });
  const denied = (e: { code?: string; message: string }) =>
    json(req, e.code === "42501" || e.code === "AUA01" || e.code === "28000" ? 403 : 400, { error: e.message, code: e.code });

  if (body?.action === "grant") {
    const { data, error } = await user.rpc("admin_courtesy_grant", {
      p_email: email,
      p_name: body.name ? String(body.name) : null,
      p_days: Number(body.days),
      p_origin: String(body.origin ?? ""),
      p_reason: String(body.reason ?? ""),
    });
    if (error) return denied(error);
    const g = data as { courtesy_id: string; ends_at: string; has_account: boolean };
    // Conta nova: cria o login e manda o e-mail. Se falhar, a cortesia já existe e a dona pode reenviar.
    let account: Record<string, unknown> = { created: false, emailSent: false, hadAccount: true };
    if (!g.has_account) {
      const a = await ensureAccountAndInvite(email, body.name ? String(body.name).trim().slice(0, 120) : null, true);
      account = a.ok ? { created: a.created, emailSent: a.emailSent, hadAccount: !a.created } : { created: false, emailSent: false, hadAccount: false, error: true };
      log({ action: "grant", email: mask(email), courtesy: g.courtesy_id, account: a.ok ? { created: a.created, emailSent: a.emailSent } : { error: a.detail } });
    } else {
      log({ action: "grant", email: mask(email), courtesy: g.courtesy_id, account: "já tinha conta" });
    }
    return json(req, 200, { ok: true, courtesy_id: g.courtesy_id, ends_at: g.ends_at, account });
  }

  if (body?.action === "invite") {
    // Só para e-mail com cortesia ativa (a lista exige superadmin + MFA).
    const { data, error } = await user.rpc("admin_list_courtesies", { p_email: email });
    if (error) return denied(error);
    const active = ((data as { situation?: string }[]) ?? []).some((c) => c.situation === "ativa" || c.situation === "termina_em_breve" || c.situation === "sem_prazo");
    if (!active) return json(req, 400, { error: "Não há cortesia ativa para este e-mail." });
    const a = await ensureAccountAndInvite(email, null, true);
    log({ action: "invite", email: mask(email), ok: a.ok });
    if (!a.ok) return json(req, 502, { error: "Não foi possível enviar o e-mail agora. Tente de novo em instantes." });
    return json(req, 200, { ok: true, created: a.created, emailSent: a.emailSent });
  }
  return json(req, 400, { error: "Ação desconhecida." });
});
