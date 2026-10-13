// Testes da tela de WhatsApp em CHROMIUM REAL, com o painel verdadeiro e uma
// API simulada (window.__wa). Mede o que só um navegador mostra: o que aparece,
// o que some, cliques, teclado, contagem do QR e larguras de tela.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(join(HERE, "dist", "index.html")).href;
const SHOTS = join(HERE, "screenshots");
mkdirSync(SHOTS, { recursive: true });

let browser;
before(async () => {
  browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
});
after(async () => browser?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusData = (status, extra = {}) => ({
  data: { status, can_manage: true, can_send: status === "connected", qr_available: status === "qr_pending", ...extra },
});

async function open({ role = "owner", width = 390, height = 844, setup, view = "" } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // o cenário inicial é aplicado ANTES do painel montar
  await page.evaluateOnNewDocument((s) => {
    window.__initial = s;
    // visibilidade da aba controlável pelo teste (para simular esconder/voltar)
    window.__vis = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis });
  }, setup ?? null);
  await page.goto(`${PAGE}?role=${role}${view ? `&view=${view}` : ""}`);
  page.errors = errors;
  return page;
}
// esconde e mostra a aba: a tela pausa e, ao voltar, consulta na hora
const forceRefresh = (page) =>
  page.evaluate(() => {
    window.__vis = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    window.__vis = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
const set = (page, patch) => page.evaluate((p) => Object.assign(window.__wa.sc, p), patch);
const calls = (page) => page.evaluate(() => ({ ...window.__wa.calls }));
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, t, timeout = 6000) =>
  page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
const noText = (page, t, timeout = 6000) =>
  page.waitForFunction((x) => !document.body.innerText.includes(x), { timeout }, t);
const clickButton = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === l);
    if (!b) throw new Error(`botão não encontrado: ${l}`);
    b.click();
  }, label);
const buttons = (page) => page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter(Boolean));
const noHorizontalScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("U1 owner, desconectado: status claro e botão Conectar; nada de QR", async () => {
  const page = await open();
  await waitText(page, "Desconectado");
  assert.ok((await buttons(page)).includes("Conectar WhatsApp"));
  assert.equal(await page.$('[data-testid="wa-qr"]'), null);
  await page.screenshot({ path: join(SHOTS, "01-desconectado-390.png"), fullPage: true });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("U2 conectar: um único pedido (mesmo com cliques repetidos), aviso de pedido enviado, nunca 'Conectado'", async () => {
  const page = await open();
  await waitText(page, "Conectar WhatsApp");
  await set(page, { status: statusData("connect_requested"), delayMs: 300 });
  await clickButton(page, "Conectar WhatsApp");
  await page.evaluate(() => [...document.querySelectorAll("button")].forEach((b) => b.innerText.includes("Conectar") && b.click()));
  await waitText(page, "Pedido de conexão enviado");
  await waitText(page, "Preparando conexão");
  assert.equal((await calls(page)).requestConnection, 1);
  const body = await text(page);
  assert.ok(!/\bConectado\b/.test(body.replace("Desconectado", "")), "não pode anunciar conectado");
  await page.close();
});

test("U3 QR: aparece para owner com contagem; some ao vencer; o seguinte aparece sozinho", async () => {
  const page = await open({
    setup: {
      status: statusData("qr_pending"),
      qr: { data: { qr: "2@QR-TESTE-PRIMEIRO-abcdefghij", expires_at: new Date(Date.now() + 6000).toISOString() } },
    },
  });
  await page.waitForSelector('[data-testid="wa-qr"] svg', { timeout: 20000 });
  const s1 = await page.$eval('[data-testid="wa-qr-seconds"]', (e) => e.innerText);
  await page.screenshot({ path: join(SHOTS, "02-qr-390.png"), fullPage: true });
  await sleep(2100);
  const s2 = await page.$eval('[data-testid="wa-qr-seconds"]', (e) => e.innerText);
  assert.notEqual(s1, s2, "contagem regressiva andando");
  // o banco não devolve mais QR (venceu) -> sai da tela
  await set(page, { qr: { data: { qr: null } } });
  await page.waitForSelector('[data-testid="wa-qr-waiting"]', { timeout: 9000 });
  assert.equal(await page.$('[data-testid="wa-qr"]'), null, "QR vencido não fica na tela");
  // chega o QR seguinte
  await set(page, { qr: { data: { qr: "2@QR-TESTE-SEGUNDO-abcdefghij", expires_at: new Date(Date.now() + 60000).toISOString() } } });
  await page.waitForSelector('[data-testid="wa-qr"] svg', { timeout: 6000 });
  await page.close();
});

test("U4 profissional e recepção: veem o status, NÃO veem QR nem botões, e a tela nem pede o QR", async () => {
  for (const role of ["professional", "reception"]) {
    const page = await open({ role, setup: { status: statusData("qr_pending", { can_manage: false, qr_available: false }) } });
    await waitText(page, "Aguardando leitura do QR");
    await sleep(2500);
    assert.equal(await page.$('[data-testid="wa-qr"]'), null);
    assert.equal(await page.$('[data-testid="wa-qr-waiting"]'), null);
    const b = await buttons(page);
    assert.ok(!b.some((x) => /Conectar|Desconectar|Cancelar conexão/.test(x)), `${role}: ${b}`);
    assert.match(await text(page), /Só a administração da empresa conecta ou desconecta/);
    assert.match(await text(page), /A administração da empresa está conectando/);
    assert.equal((await calls(page)).getQr, 0, role);
    if (role === "professional") await page.screenshot({ path: join(SHOTS, "03-profissional-390.png"), fullPage: true });
    await page.close();
  }
});

test("U5 conectado: número formatado; desconectar pede confirmação; Esc cancela sem desconectar", async () => {
  const page = await open({ setup: { status: statusData("connected", { phone: "5511987654321", connected_at: "2026-10-12T15:30:00Z" }) } });
  await page.waitForFunction(() => document.querySelector('[data-testid="wa-phone"]')?.innerText === "(11) 98765-4321", { timeout: 20000 });
  assert.match(await text(page), /Conectado em 12\/10, 12:30/);
  await page.screenshot({ path: join(SHOTS, "04-conectado-390.png"), fullPage: true });
  await clickButton(page, "Desconectar");
  await waitText(page, "Desconectar o WhatsApp?");
  await page.screenshot({ path: join(SHOTS, "05-confirmar-desconexao-390.png") });
  await page.keyboard.press("Escape");
  await noText(page, "Desconectar o WhatsApp?");
  assert.equal((await calls(page)).disconnect, 0);
  // agora confirma
  await set(page, { status: statusData("disconnect_requested") });
  await clickButton(page, "Desconectar");
  await waitText(page, "Desconectar o WhatsApp?");
  await page.evaluate(() => {
    const dlg = [...document.querySelectorAll("button")].filter((b) => b.innerText.trim() === "Desconectar");
    dlg[dlg.length - 1].click();
  });
  await waitText(page, "Pedido de desconexão enviado");
  await waitText(page, "Desconectando");
  assert.equal((await calls(page)).disconnect, 1);
  await page.close();
});

test("U6 banco/rede fora: mantém o último estado com aviso de desatualizado; 'Tentar agora' consulta de novo", async () => {
  const page = await open({ setup: { status: statusData("connected", { phone: "5511987654321" }) } });
  await waitText(page, "(11) 98765-4321");
  await set(page, { status: { error: { message: "TypeError: Failed to fetch" } } });
  await forceRefresh(page);
  await waitText(page, "pode estar desatualizado");
  assert.match(await text(page), /Sem conexão com o servidor/);
  assert.equal(await page.$eval('[data-testid="wa-status"]', (e) => e.innerText), "Última informação: Conectado");
  assert.ok(!(await buttons(page)).includes("Desconectar"), "sem servidor, nada de ações que dependem dele");
  assert.ok(!(await text(page)).includes("está conectado à Áurea"), "nenhuma afirmação de estado sem confirmação");
  await page.screenshot({ path: join(SHOTS, "06-sem-conexao-390.png"), fullPage: true });
  const before = (await calls(page)).getStatus;
  await set(page, { status: statusData("connected", { phone: "5511987654321" }) });
  await clickButton(page, "Tentar agora");
  await noText(page, "pode estar desatualizado");
  assert.ok((await calls(page)).getStatus > before);
  await page.close();
});

test("U6b primeira consulta falha: tela de erro com 'Tentar agora' (nenhum estado inventado)", async () => {
  const page = await open({ setup: { status: { error: { code: "XX000", message: "boom" } } } });
  await waitText(page, "Não foi possível consultar o WhatsApp");
  assert.ok(!/Conectado|Desconectado/.test(await text(page)));
  await set(page, { status: statusData("disconnected") });
  await clickButton(page, "Tentar agora");
  await waitText(page, "Conectar WhatsApp");
  await page.close();
});

test("U7 integração ausente (0017 não aplicada): 'WhatsApp indisponível', sem botões", async () => {
  const page = await open({ setup: { status: { error: { code: "PGRST202", message: "Could not find the function" } } } });
  await waitText(page, "WhatsApp indisponível");
  assert.equal((await buttons(page)).length, 0);
  await page.close();
});

test("U8 erro e 'sem sinal': mensagens próprias e opção de conectar de novo", async () => {
  const page = await open({ setup: { status: statusData("error", { last_error: "Sessão aberta em outro lugar." }) } });
  await waitText(page, "Erro na conexão");
  assert.match(await text(page), /Sessão aberta em outro lugar\./);
  assert.ok((await buttons(page)).includes("Conectar de novo"));
  await page.screenshot({ path: join(SHOTS, "07-erro-390.png"), fullPage: true });
  await page.close();
  const p2 = await open({ setup: { status: statusData("stale") } });
  await waitText(p2, "Sem sinal");
  assert.match(await text(p2), /não responde há alguns minutos/);
  await p2.close();
});

test("U9 teclado e acessibilidade: QR com descrição, status anunciado, botões alcançáveis por Tab com foco visível", async () => {
  const page = await open({
    setup: {
      status: statusData("qr_pending"),
      qr: { data: { qr: "2@QR-TESTE-A11Y-abcdefghijklmn", expires_at: new Date(Date.now() + 60000).toISOString() } },
    },
  });
  await page.waitForSelector('[data-testid="wa-qr"] svg', { timeout: 20000 });
  assert.equal(await page.$eval('[data-testid="wa-qr"]', (e) => e.getAttribute("aria-label")), "QR Code para conectar o WhatsApp da empresa");
  assert.ok(await page.$('[aria-live="polite"] [data-testid="wa-status"]'));
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, text: el.innerText.trim(), outline: cs.outlineStyle };
  });
  assert.equal(focused.tag, "BUTTON");
  assert.equal(focused.text, "Cancelar conexão");
  assert.notEqual(focused.outline, "none", "foco visível");
  await page.close();
});

test("U10 responsividade: 320, 390, 768 e 1280 px sem rolagem lateral; QR inteiro na tela", async () => {
  for (const width of [320, 390, 768, 1280]) {
    const page = await open({
      width,
      height: 900,
      setup: {
        status: statusData("qr_pending"),
        qr: { data: { qr: "2@QR-TESTE-LARGURA-abcdefghijk", expires_at: new Date(Date.now() + 60000).toISOString() } },
      },
    });
    await page.waitForSelector('[data-testid="wa-qr"] svg', { timeout: 20000 });
    assert.ok(await noHorizontalScroll(page), `rolagem lateral em ${width}px`);
    const box = await page.$eval('[data-testid="wa-qr"]', (e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, w: r.width, h: r.height };
    });
    assert.ok(box.left >= 0 && box.right <= width, `QR fora da tela em ${width}px`);
    assert.ok(box.w >= 180, `QR pequeno demais para ler (${box.w}px) em ${width}px`);
    assert.ok(Math.abs(box.w - box.h) < 2, "QR quadrado");
    await page.screenshot({ path: join(SHOTS, `08-qr-${width}.png`), fullPage: true });
    await set(page, { status: statusData("connected", { phone: "5511987654321" }) });
    await forceRefresh(page);
    await waitText(page, "(11) 98765-4321", 20000);
    assert.ok(await noHorizontalScroll(page), `rolagem lateral (conectado) em ${width}px`);
    await page.screenshot({ path: join(SHOTS, `09-conectado-${width}.png`), fullPage: true });
    await page.close();
  }
});

test("U11 a parte visual nunca desenha QR vencido, mesmo se receber um", async () => {
  const page = await open({ view: "expired-qr" });
  await page.waitForSelector('[data-testid="wa-qr-waiting"]', { timeout: 6000 });
  assert.equal(await page.$('[data-testid="wa-qr"]'), null);
  await page.close();
});

// ============================================================ W5 (0018)
// Preferência da empresa: cliente do Supabase SIMULADO (window.__rpc), nunca o real.
async function openAuto({ role = "owner", get, set: setReply = { data: { enabled: false }, error: null }, width = 390 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((cfg) => {
    window.__auto = { calls: [], ...cfg };
    window.__rpc = async (fn, args) => {
      window.__auto.calls.push({ fn, args });
      await new Promise((r) => setTimeout(r, 20));
      return fn === "wa_get_auto_confirmation" ? window.__auto.get : window.__auto.set;
    };
  }, { get, set: setReply });
  await page.goto(`${PAGE}?role=${role}&view=auto`);
  page.__errors = errors;
  return page;
}
const autoCalls = (page) => page.evaluate(() => window.__auto.calls);
const prefData = (o = {}) => ({ data: { enabled: true, configured: true, available: true, can_manage: true, ...o }, error: null });

test("U12 confirmação automática: oculta se o recurso não foi ligado, se a empresa nunca conectou ou se a 0018 não existe", async () => {
  for (const get of [prefData({ available: false }), prefData({ configured: false }), { data: null, error: { code: "PGRST202", message: "x" } }]) {
    const page = await openAuto({ get });
    await sleep(300);
    assert.equal(await page.$('[data-testid="wa-auto-confirmation"]'), null, JSON.stringify(get));
    assert.deepEqual(page.__errors, []);
    await page.close();
  }
});

test("U13 owner desliga a confirmação automática: chama o banco com false e a tela muda só depois da resposta", async () => {
  const page = await openAuto({ get: prefData() });
  await page.waitForSelector('[data-testid="wa-auto-confirmation"] [role="switch"]', { timeout: 6000 });
  assert.equal(await page.$eval('[role="switch"]', (e) => e.getAttribute("aria-checked")), "true");
  await page.screenshot({ path: join(SHOTS, "20-auto-ligada.png"), fullPage: true });
  await page.click('[role="switch"]');
  await waitText(page, "Desligada:");
  assert.equal(await page.$eval('[role="switch"]', (e) => e.getAttribute("aria-checked")), "false");
  const sets = (await autoCalls(page)).filter((c) => c.fn === "wa_set_auto_confirmation");
  assert.equal(sets.length, 1);
  assert.equal(sets[0].args.p_enabled, false);
  await page.screenshot({ path: join(SHOTS, "21-auto-desligada.png"), fullPage: true });
  await page.close();
});

test("U14 profissional/recepção: vê a situação, interruptor desabilitado, nenhum pedido de alteração", async () => {
  const page = await openAuto({ role: "professional", get: prefData({ can_manage: false }) });
  await page.waitForSelector('[data-testid="wa-auto-confirmation"]', { timeout: 6000 });
  assert.equal(await page.$eval('[role="switch"]', (e) => e.disabled), true);
  await waitText(page, "Só a administração da empresa pode mudar.");
  await page.click('[role="switch"]').catch(() => {});
  await sleep(200);
  assert.equal((await autoCalls(page)).filter((c) => c.fn === "wa_set_auto_confirmation").length, 0);
  await page.close();
});

test("U15 banco recusa a alteração: mostra o motivo e NÃO finge que mudou", async () => {
  const page = await openAuto({ get: prefData(), set: { data: null, error: { code: "42501", message: "x" } } });
  await page.waitForSelector('[role="switch"]', { timeout: 6000 });
  await page.click('[role="switch"]');
  await waitText(page, "Só a administração da empresa pode mudar isso.");
  assert.equal(await page.$eval('[role="switch"]', (e) => e.getAttribute("aria-checked")), "true");
  assert.ok(await page.$('[role="alert"]'));
  await page.close();
});

test("U16 situação da confirmação: rótulos certos, quem dispensa o wa.me, nada para 'none'; sem rolagem lateral em 320 px", async () => {
  const cases = ["queued", "sent", "read", "failed:no_whatsapp", "skipped:not_connected", "skipped:blocked", "canceled:recipient_blocked", "none", "skipped:no_phone"];
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${PAGE}?view=confirmation&cases=${cases.join(",")}`);
  await page.waitForSelector('[data-case="queued"]', { timeout: 6000 });
  const got = await page.$$eval("[data-case]", (els) => els.map((e) => ({
    c: e.dataset.case, empty: e.dataset.empty === "true", auto: e.dataset.auto, manual: e.dataset.manual, t: e.innerText.trim(),
  })));
  const by = Object.fromEntries(got.map((g) => [g.c, g]));
  assert.match(by.queued.t, /Confirmação na fila/); assert.equal(by.queued.auto, "true"); assert.equal(by.queued.manual, "false");
  assert.match(by.sent.t, /Confirmação enviada/);
  assert.match(by.read.t, /lida/);
  assert.match(by["failed:no_whatsapp"].t, /não tem WhatsApp/); assert.equal(by["failed:no_whatsapp"].manual, "false");
  assert.equal(by["skipped:not_connected"].manual, "true");
  for (const k of ["skipped:blocked", "canceled:recipient_blocked"]) {
    assert.match(by[k].t, /pediu para não receber/); assert.equal(by[k].manual, "false");
  }
  assert.equal(by.none.empty, true); assert.equal(by["skipped:no_phone"].empty, true);
  assert.ok(await noHorizontalScroll(page));
  assert.equal((await page.$$('[data-testid="wa-confirmation"][role="status"]')).length, 7, "anunciado a leitores de tela");
  await page.screenshot({ path: join(SHOTS, "22-situacoes-confirmacao-320.png"), fullPage: true });
  await page.close();
});
