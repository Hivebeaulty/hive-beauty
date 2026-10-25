import { calls, cfgStub } from "./stub.ts";
Deno.env.set("SUPABASE_URL", "x"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "y"); Deno.env.set("BREVO_API_KEY", "chave");
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
const sent: any[] = []; let brevoStatus = 201;
(globalThis as any).fetch = async (url: string, init: any) => { sent.push({ url, init, body: JSON.parse(init.body) });
  return new Response(brevoStatus < 300 ? JSON.stringify({ messageId: "<m1@brevo>" }) : '{"message":"invalid sender"}', { status: brevoStatus }); };
const m = await import("./index.ts");
let pass = 0, fail = 0; const check = (n: string, c: boolean, x = "") => { c ? pass++ : fail++; console.info((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + x)); };
const post = (h: Record<string, string> = { "x-cron-secret": "s".repeat(64) }) => handler(new Request("https://f/billing-emails", { method: "POST", headers: h, body: "{}" }));
const W = { preapproval_id: "P1", email: "Nova@x.com", status: "trialing", next_payment_at: "2026-11-12T15:00:00Z", amount: 59.9 };
const T = { preapproval_id: "P2", email: "dia5@x.com", next_payment_at: "2026-11-12T15:00:00Z", amount: 59.9 };

cfgStub.secretOk = false; calls.length = 0; sent.length = 0;
{ const r = await post(); check("sem o segredo certo: 401 e nada enviado", r.status === 401 && sent.length === 0 && !calls.some((c) => c[0] === "billing_email_targets")); }
cfgStub.secretOk = true;
{ const r = await handler(new Request("https://f/x", { method: "GET" })); check("só POST", r.status === 405); }

cfgStub.targets = { welcome: [W], trial_ending: [T] }; calls.length = 0; sent.length = 0;
{ const r = await post(); const j = await r.json();
  check("envia boas-vindas e aviso", r.status === 200 && j.sent === 2 && sent.length === 2, JSON.stringify(j));
  check("cada envio é reservado antes de sair", calls.filter((c) => c[0] === "billing_email_claim").length === 2);
  const fin = calls.filter((c) => c[0] === "billing_email_finish");
  check("cada envio é registrado como enviado, com o id do Brevo", fin.length === 2 && fin.every((c) => c[1].p_ok === true && c[1].p_message_id === "<m1@brevo>"));
  const b = sent[0].body;
  check("Brevo: remetente, resposta e chave", b.sender.email === "hivebeauty.suporte@gmail.com" && b.sender.name === "Áurea" && b.replyTo.email === "hivebeauty.suporte@gmail.com" && sent[0].init.headers["api-key"] === "chave" && sent[0].url === "https://api.brevo.com/v3/smtp/email");
  check("boas-vindas: assunto, link do app e do guia", b.subject === "Boas-vindas à Áurea: seus primeiros passos" && b.htmlContent.includes("https://hive-beauty.vercel.app/login") && b.htmlContent.includes("https://hive-beauty.vercel.app/guia-aurea.pdf"));
  check("boas-vindas: data e valor da primeira cobrança", b.htmlContent.includes("quinta-feira, 12 de novembro") && b.htmlContent.includes("R$ 59,90"), b.htmlContent.slice(0, 0));
  check("tem versão em texto puro", b.textContent.includes("Esqueci minha senha") && !b.textContent.includes("<"));
  const t = sent[1].body;
  check("aviso: valor, data e como cancelar", t.htmlContent.includes("R$ 59,90") && t.htmlContent.includes("quinta-feira, 12 de novembro") && t.htmlContent.includes("Assinaturas") && t.htmlContent.includes("nada será cobrado")); }

calls.length = 0; sent.length = 0; brevoStatus = 400;
{ const r = await post(); const j = await r.json(); const fin = calls.filter((c) => c[0] === "billing_email_finish");
  check("falha do Brevo: registrada como erro (o banco tenta de novo depois)", j.failed === 2 && fin.every((c) => c[1].p_ok === false && String(c[1].p_error).includes("Brevo 400"))); }
brevoStatus = 201;

cfgStub.claim = () => null; calls.length = 0; sent.length = 0;
{ const r = await post(); const j = await r.json(); check("reserva recusada (já enviado): não envia", j.skipped === 2 && sent.length === 0); }
cfgStub.claim = () => 7;

Deno.env.delete("BREVO_API_KEY"); calls.length = 0; sent.length = 0;
{ const r = await post(); check("sem BREVO_API_KEY: erro e nenhuma reserva", r.status === 500 && !calls.some((c) => c[0] === "billing_email_claim")); }
Deno.env.set("BREVO_API_KEY", "chave");

const now = new Date("2026-11-10T15:00:00Z");
check("quando: amanhã / em 2 dias", m.whenPhrase("2026-11-11T20:00:00Z", now) === "amanhã" && m.whenPhrase("2026-11-12T15:00:00Z", now) === "em 2 dias");
check("assunto do aviso acompanha a data", m.trialEndingEmail(T, m.cfg(), now).subject === "Seu teste da Áurea termina em 2 dias");
check("virada do dia em Brasília (02h UTC = 23h do dia anterior)", m.whenPhrase("2026-11-12T02:00:00Z", now) === "amanhã");
check("valor ausente: usa R$ 59,90", m.money(null) === "R$ 59,90" && m.money(79.9) === "R$ 79,90");
check("escape de HTML", m.esc('<a href="x">&') === "&lt;a href=&quot;x&quot;&gt;&amp;");
check("assinatura já ativa: sem texto de teste", !m.welcomeEmail({ ...W, status: "active" }).html.includes("7 dias grátis"));
Deno.env.set("EMAIL_FROM", "contato@aurea.com.br");
check("remetente configurável (domínio próprio no futuro)", m.cfg().from === "contato@aurea.com.br" && m.cfg().replyTo === "contato@aurea.com.br");

// 0045: alerta de assinatura sem dona (vai para o suporte, não para a cliente)
cfgStub.claim = () => 9; cfgStub.targets = { welcome: [], trial_ending: [], unlinked_alert: [{ preapproval_id: "PX", mp_status: "authorized", amount: 59.9, date_created: "2026-11-10T15:00:00Z" }] };
calls.length = 0; sent.length = 0; Deno.env.delete("EMAIL_FROM");
{ const r = await post(); const j = await r.json(); const b = sent[0]?.body;
  check("alerta sem dona: enviado ao suporte", j.sent === 1 && b.to[0].email === "hivebeauty.suporte@gmail.com" && b.subject === "Assinatura sem dona: PX", JSON.stringify(j));
  check("alerta: reserva pelo id da assinatura e e-mail do suporte", calls.some((c) => c[0] === "billing_email_claim" && c[1].p_kind === "unlinked_alert" && c[1].p_preapproval_id === "PX" && c[1].p_email === "hivebeauty.suporte@gmail.com"));
  check("alerta: diz o que fazer e leva ao painel", b.htmlContent.includes("Assinaturas sem dona") && b.htmlContent.includes("/admin/financeiro") && b.htmlContent.includes("R$ 59,90")); }
Deno.env.set("ALERT_EMAIL", "dono@x.com");
check("destinatário do alerta configurável", m.cfg().alert === "dono@x.com");
console.info(`RESULTADO billing-emails: PASS=${pass} FAIL=${fail}`);
