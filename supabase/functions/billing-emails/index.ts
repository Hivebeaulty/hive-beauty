// billing-emails — e-mails da assinatura (0042). Publicar SEM exigir JWT: quem chama é o
// pg_cron (a cada 15 min), com o segredo do Vault no cabeçalho x-cron-secret.
//
//   welcome       boas-vindas quando a assinatura começa (link do app e do guia em PDF)
//   trial_ending  aviso ~2 dias antes da primeira cobrança (data, valor, como cancelar)
//   unlinked_alert alerta ao SUPORTE: assinatura sem dona há mais de 10 min (0045)
//
// O banco decide quem recebe (billing_email_targets) e garante que nada sai duas vezes
// (billing_email_claim / billing_email_finish). Envio pela API do Brevo.
// Segredos: BREVO_API_KEY (obrigatório); EMAIL_FROM, EMAIL_FROM_NAME, EMAIL_REPLY_TO,
// APP_URL, GUIDE_URL, LANDING_URL, ALERT_EMAIL (opcionais, com padrão).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const env = (k: string, d = "") => (Deno.env.get(k) ?? "").trim() || d;
const MAX_PER_RUN = 30;

export const cfg = () => ({
  key: env("BREVO_API_KEY"),
  from: env("EMAIL_FROM", "hivebeauty.suporte@gmail.com"),
  fromName: env("EMAIL_FROM_NAME", "Áurea"),
  replyTo: env("EMAIL_REPLY_TO", env("EMAIL_FROM", "hivebeauty.suporte@gmail.com")),
  app: env("APP_URL", "https://hive-beauty.vercel.app"),
  guide: env("GUIDE_URL", `${env("APP_URL", "https://hive-beauty.vercel.app")}/guia-aurea.pdf`),
  landing: env("LANDING_URL", "https://aurea-hivebeauty.lovable.app"),
  alert: env("ALERT_EMAIL", env("EMAIL_REPLY_TO", env("EMAIL_FROM", "hivebeauty.suporte@gmail.com"))),
  whatsapp: "(31) 99919-1534",
  whatsappUrl: "https://wa.me/5531999191534",
});

const TZ = "America/Sao_Paulo";
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const money = (v: unknown) => {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 ? n : 59.9).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/\u00a0/g, " ");
};
export const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
/** "amanhã", "em 2 dias"… pela diferença de datas no fuso de Brasília. */
export function whenPhrase(iso: string, now = new Date()) {
  const days = Math.round((Date.parse(ymd(new Date(iso))) - Date.parse(ymd(now))) / 86400000);
  return days <= 0 ? "hoje" : days === 1 ? "amanhã" : `em ${days} dias`;
}

// ---- layout ------------------------------------------------------------------------------
function layout(c: ReturnType<typeof cfg>, preheader: string, inner: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Áurea</title></head>
<body style="margin:0;padding:0;background:#F3EADF;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3EADF;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FAF7F2;border-radius:12px;">
<tr><td style="padding:28px 32px 8px;"><img src="${c.app}/logo-lockup.png" width="132" alt="Áurea" style="display:block;border:0;"></td></tr>
<tr><td style="padding:8px 32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2C2C2E;">${inner}</td></tr>
<tr><td style="padding:20px 32px 28px;border-top:1px solid #E6DDD2;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#6E6862;">
Dúvidas? Responda este e-mail ou chame no WhatsApp <a href="${c.whatsappUrl}" style="color:#7E6338;">${c.whatsapp}</a>.<br>
Para cancelar, acesse Assinaturas no Mercado Pago, sem multa.<br>
<a href="${c.landing}/termos" style="color:#6E6862;">Termos de Uso</a> · <a href="${c.landing}/privacidade" style="color:#6E6862;">Política de Privacidade</a>
</td></tr></table></td></tr></table></body></html>`;
}
const h1 = (t: string) => `<h1 style="margin:8px 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:26px;line-height:1.25;color:#2C2C2E;">${t}</h1>`;
const button = (href: string, label: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 10px;"><tr><td style="border-radius:999px;background:#3A2A22;">
<a href="${href}" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FAF7F2;text-decoration:none;border-radius:999px;">${label}</a></td></tr></table>`;
const box = (inner: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr><td style="background:#F2EBE1;border-radius:10px;padding:16px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#2C2C2E;">${inner}</td></tr></table>`;

type Target = { preapproval_id: string; email: string; status?: string; next_payment_at?: string | null; amount?: number | null };
type Mail = { subject: string; html: string; text: string };

export function welcomeEmail(t: Target, c = cfg()): Mail {
  const trial = t.status === "trialing" && t.next_payment_at;
  const charge = trial ? `A primeira cobrança, de ${money(t.amount)}, acontece em ${longDate(t.next_payment_at!)}, pelo Mercado Pago. Até lá, você usa tudo sem pagar nada.` : "Sua assinatura está ativa.";
  const html = layout(c, "Seu acesso está pronto. Veja como deixar tudo funcionando na primeira semana.",
    `${h1('Boas-vindas à Áurea.')}
<p style="margin:0 0 12px;">Que bom ter você aqui. ${trial ? "Seus 7 dias grátis já começaram." : ""}</p>
${box(esc(charge))}
<p style="margin:18px 0 6px;"><strong>1. Crie sua senha.</strong> Enviamos outro e-mail com o link para criar a senha. Não encontrou? Veja a caixa de spam ou toque em <em>Esqueci minha senha</em> na tela de entrada.</p>
<p style="margin:12px 0 6px;"><strong>2. Entre no app.</strong> Dica: deixe a Áurea na tela inicial do celular, como um aplicativo.</p>
${button(`${c.app}/login`, "Entrar na Áurea")}
<p style="margin:16px 0 6px;"><strong>3. Siga o guia.</strong> Em poucos minutos você cadastra os serviços, importa suas clientes e conecta o WhatsApp.</p>
${button(c.guide, "Baixar o guia de uso (PDF)")}
<p style="margin:16px 0 0;">Você cuida das clientes. A Áurea cuida da rotina.</p>`);
  const text = `Boas-vindas à Áurea.\n\n${trial ? "Seus 7 dias grátis já começaram. " : ""}${charge}\n\n` +
    `1. Crie sua senha pelo link do outro e-mail que enviamos (veja o spam, ou use "Esqueci minha senha").\n` +
    `2. Entre no app: ${c.app}/login\n3. Siga o guia de uso: ${c.guide}\n\n` +
    `Dúvidas? Responda este e-mail ou chame no WhatsApp ${c.whatsapp}.\nPara cancelar, acesse Assinaturas no Mercado Pago, sem multa.`;
  return { subject: "Boas-vindas à Áurea: seus primeiros passos", html, text };
}

export function trialEndingEmail(t: Target, c = cfg(), now = new Date()): Mail {
  const when = whenPhrase(t.next_payment_at!, now);
  const date = longDate(t.next_payment_at!); const value = money(t.amount);
  const html = layout(c, `Seu teste termina ${when}. Veja a data e o valor da primeira cobrança.`,
    `${h1(`Seu teste termina ${esc(when)}.`)}
<p style="margin:0 0 12px;">Passando para avisar com antecedência, como combinado.</p>
${box(`Em <strong>${esc(date)}</strong>, o Mercado Pago faz a primeira cobrança de <strong>${esc(value)}</strong>, na forma de pagamento que você cadastrou. Depois, a cobrança é mensal.`)}
<p style="margin:16px 0 6px;"><strong>Quer continuar?</strong> Não precisa fazer nada.</p>
<p style="margin:12px 0 6px;"><strong>Prefere não continuar?</strong> Cancele antes dessa data em Assinaturas, no app ou no site do Mercado Pago, sem multa, e nada será cobrado. Se preferir, responda este e-mail que cancelamos para você.</p>
<p style="margin:16px 0 6px;">Ainda falta configurar alguma coisa? O guia mostra o caminho em poucos minutos.</p>
${button(c.guide, "Abrir o guia de uso")}`);
  const text = `Seu teste da Áurea termina ${when}.\n\nEm ${date}, o Mercado Pago faz a primeira cobrança de ${value}, na forma de pagamento que você cadastrou. Depois, a cobrança é mensal.\n\n` +
    `Quer continuar? Não precisa fazer nada.\nPrefere não continuar? Cancele antes dessa data em Assinaturas, no app ou no site do Mercado Pago, sem multa. Ou responda este e-mail que cancelamos para você.\n\n` +
    `Guia de uso: ${c.guide}\nDúvidas? WhatsApp ${c.whatsapp}.`;
  return { subject: `Seu teste da Áurea termina ${when}`, html, text };
}

type Unlinked = { preapproval_id: string; mp_status?: string | null; amount?: number | null; date_created?: string | null; first_seen?: string };
/** Alerta interno ao suporte (não vai para a cliente). */
export function unlinkedAlertEmail(u: Unlinked, c = cfg()): Mail {
  const when = u.date_created ? longDate(u.date_created) : "data não informada";
  const html = layout(c, "Uma assinatura do Mercado Pago está sem dona. Ligue a um e-mail no painel.",
    `${h1("Assinatura sem dona")}
<p style="margin:0 0 12px;">O Mercado Pago não informou o e-mail desta assinatura e nenhuma conta ou e-mail informado no site correspondeu. A cliente pagou e ainda <strong>não tem acesso</strong>.</p>
${box(`Assinatura: <strong>${esc(u.preapproval_id)}</strong><br>Situação no Mercado Pago: ${esc(u.mp_status ?? "não informada")}<br>Valor: ${esc(money(u.amount))}<br>Criada em: ${esc(when)}`)}
<p style="margin:16px 0 6px;"><strong>O que fazer:</strong> descubra o e-mail da cliente (no painel do Mercado Pago, em Assinaturas, ou falando com ela) e ligue no painel da Áurea, em Assinaturas e financeiro › Assinaturas sem dona. Em até 5 minutos a conta é criada e ela recebe o e-mail de senha.</p>
${button(`${c.app}/admin/financeiro`, "Abrir o painel")}`);
  const text = `Assinatura sem dona: ${u.preapproval_id} (${u.mp_status ?? "situação não informada"}, ${money(u.amount)}, criada em ${when}).\n` +
    `A cliente pagou e ainda não tem acesso. Ligue a assinatura a um e-mail no painel: ${c.app}/admin/financeiro`;
  return { subject: `Assinatura sem dona: ${u.preapproval_id}`, html, text };
}

// ---- envio --------------------------------------------------------------------------------
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "billing-emails", ...o }));

async function brevo(c: ReturnType<typeof cfg>, to: string, m: Mail) {
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": c.key, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: c.fromName, email: c.from }, to: [{ email: to }], replyTo: { email: c.replyTo },
                             subject: m.subject, htmlContent: m.html, textContent: m.text }),
    });
    const body = await r.text();
    if (!r.ok) return { ok: false, error: `Brevo ${r.status}: ${body.replace(/\s+/g, " ").slice(0, 200)}` };
    let id = ""; try { id = JSON.parse(body).messageId ?? ""; } catch { /* sem id */ }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "erro de rede" };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Método não permitido.", { status: 405 });
  const secret = req.headers.get("x-cron-secret") ?? "";
  const { data: okSecret } = await service.rpc("billing_emails_secret_ok", { p_secret: secret });
  if (okSecret !== true) return new Response("Não autorizado.", { status: 401 });
  const c = cfg();
  if (!c.key) { log({ error: "BREVO_API_KEY ausente" }); return new Response(JSON.stringify({ error: "BREVO_API_KEY ausente" }), { status: 500 }); }

  const { data, error } = await service.rpc("billing_email_targets");
  if (error) { log({ error: error.message }); return new Response(JSON.stringify({ error: error.message }), { status: 500 }); }
  type Kind = "welcome" | "trial_ending" | "unlinked_alert";
  const jobs: { kind: Kind; t: Target; to: string; mail: () => Mail }[] = [
    ...((data?.unlinked_alert ?? []) as Unlinked[]).map((u) => ({ kind: "unlinked_alert" as const, t: { preapproval_id: u.preapproval_id, email: c.alert }, to: c.alert, mail: () => unlinkedAlertEmail(u, c) })),
    ...((data?.welcome ?? []) as Target[]).map((t) => ({ kind: "welcome" as const, t, to: t.email, mail: () => welcomeEmail(t, c) })),
    ...((data?.trial_ending ?? []) as Target[]).map((t) => ({ kind: "trial_ending" as const, t, to: t.email, mail: () => trialEndingEmail(t, c) })),
  ].slice(0, MAX_PER_RUN);

  const summary = { sent: 0, failed: 0, skipped: 0 };
  for (const { kind, t, to, mail: build } of jobs) {
    const { data: id, error: ce } = await service.rpc("billing_email_claim", { p_kind: kind, p_preapproval_id: t.preapproval_id, p_email: to });
    if (ce || id == null) { summary.skipped++; continue; }
    const r = await brevo(c, to, build());
    await service.rpc("billing_email_finish", { p_id: id, p_ok: r.ok, p_message_id: r.ok ? r.id : null, p_error: r.ok ? null : r.error });
    r.ok ? summary.sent++ : summary.failed++;
    log({ kind, to: mask(to), ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }
  if (jobs.length) log({ ...summary });
  return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
});
