import { calls, cfg } from "./stub.ts";
Deno.env.set("SUPABASE_URL", "x"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "y");
let handler: any; (Deno as any).serve = (h: any) => { handler = h; };
const mod = await import("./index.ts");
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = "") => { c ? pass++ : fail++; console.info((c ? "PASS " : "FAIL ") + n + (c ? "" : "  " + x)); };
const SITE = "https://socia-beauty.lovable.app";
const UA_M = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const send = (body: unknown, h: Record<string, string> = {}) => handler(new Request("https://f/track", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { origin: SITE, "user-agent": UA_M, "x-forwarded-for": "200.1.2.3, 10.0.0.1", "content-type": "text/plain", ...h } }));
const ingest = () => calls.find((c) => c[0] === "analytics_ingest")?.[1].p;

calls.length = 0; { const r = await send({ e: "pageview", p: "/", r: "https://l.instagram.com/?u=x&e=ana@x.com", u: { utm_source: "instagram", utm_campaign: "lancamento", gclid: "zzz" } });
  const p = ingest();
  check("visita aceita: 204", r.status === 204 && !!p);
  check("identificador: 16 hex, sem IP nem navegador gravados", /^[0-9a-f]{16}$/.test(p.visitor) && !JSON.stringify(p).includes("200.1.2.3") && !JSON.stringify(p).includes("iPhone"));
  check("origem: só o domínio (instagram.com), sem o resto do endereço", p.referrer_host === "instagram.com");
  check("só UTM conhecidas seguem (gclid descartado)", p.utm_source === "instagram" && p.utm_campaign === "lancamento" && !JSON.stringify(p).includes("zzz"));
  check("aparelho: celular", p.device === "mobile"); }
calls.length = 0; await send({ e: "pageview", p: "/" }); const v1 = ingest().visitor;
calls.length = 0; await send({ e: "pageview", p: "/" }, { "x-forwarded-for": "200.9.9.9" }); const v2 = ingest().visitor;
calls.length = 0; cfg.salt = "b".repeat(64); await send({ e: "pageview", p: "/" }); const v3 = ingest().visitor; cfg.salt = "a".repeat(64);
check("mesma visitante no mesmo dia: mesmo identificador; outra rede: outro", v1 === (await (async () => { calls.length = 0; await send({ e: "pageview", p: "/" }); return ingest().visitor; })()) && v1 !== v2);
check("dia seguinte (sal novo): identificador muda (não dá para seguir a pessoa)", v1 !== v3);
calls.length = 0; { const r = await send({ e: "pageview", p: "/" }, { origin: "https://evil.com" }); check("outro site: ignorado (204, nada gravado)", r.status === 204 && calls.length === 0); }
calls.length = 0; { await send({ e: "pageview", p: "/" }, { "user-agent": "Googlebot/2.1" }); check("robô: ignorado", calls.length === 0); }
calls.length = 0; { await send({ e: "pageview", p: "/" }, { "user-agent": "" }); check("sem navegador: ignorado", calls.length === 0); }
calls.length = 0; { await send({ e: "compra" }); check("evento fora da lista: ignorado sem gastar consulta", calls.length === 0); }
calls.length = 0; { const r = await send("{isto não é json"); check("corpo inválido: 204 e nada gravado", r.status === 204 && calls.length === 0); }
calls.length = 0; { await send("x".repeat(3000)); check("corpo grande: ignorado", calls.length === 0); }
calls.length = 0; { const r = await handler(new Request("https://f/track", { method: "OPTIONS", headers: { origin: SITE } }));
  check("preflight do site: liberado só para o site", r.headers.get("access-control-allow-origin") === SITE); }
calls.length = 0; { await send({ e: "pageview", p: "/", r: `${SITE}/termos` }); check("navegação interna não vira origem", ingest().referrer_host === null); }
check("aparelhos: tablet e computador", mod.deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0)") === "tablet" && mod.deviceOf("Mozilla/5.0 (Linux; Android 14; SM-X200)") === "tablet" && mod.deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64)") === "desktop");
check("domínio próprio futuro aceito; preview do Lovable deste projeto aceito",
  await (async () => { calls.length = 0; await send({ e: "pageview", p: "/" }, { origin: "https://www.socia.com.br" }); const a = calls.length > 0;
    calls.length = 0; await send({ e: "pageview", p: "/" }, { origin: "https://id-preview--0d74345f-386a-4984-93f3-04929c0124cc.lovable.app" }); return a && calls.length > 0; })());
console.info(`RESULTADO track: PASS=${pass} FAIL=${fail}`);
