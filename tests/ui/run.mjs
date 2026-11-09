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
  assert.ok(!(await text(page)).includes("está conectado à Sócia"), "nenhuma afirmação de estado sem confirmação");
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

// ============================================================ Sprint visual — dashboard responsivo
// Mede a GEOMETRIA real no Chromium: nenhum valor invade outro nem sai da
// própria célula, em telas estreitas e largas, com valores grandes.
async function dashboardGeometry(width, query) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${PAGE}?view=dashboard&${query}`);
  await page.waitForSelector('[data-testid="today-summary"]', { timeout: 6000 });
  const r = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    // extensão REAL do texto desenhado (a caixa do <p> ocupa a célula toda mesmo se o texto transbordar)
    const ink = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
    const out = { overlaps: [], escapes: [], hscroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
    for (const sel of ['[data-testid="today-summary"]', '[data-testid="month"]']) {
      const card = document.querySelector(sel);
      const stats = [...card.querySelectorAll("[data-stat]")];
      const vals = stats.map((s) => ({ cell: rect(s), val: ink(s.querySelector("p")), lab: ink(s.querySelectorAll("p")[1]),
        overflow: s.querySelector("p").scrollWidth > s.querySelector("p").clientWidth + 1, text: s.innerText.replace(/\n/g, " | ") }));
      const cr = rect(card);
      for (const v of vals) {
        if (v.overflow || v.val.right > v.cell.right + 1 || v.val.left < v.cell.left - 1) out.escapes.push(`${sel}: valor sai da célula: ${v.text}`);
        if (v.val.right > cr.right - 8) out.escapes.push(`${sel}: valor encosta/sai do cartão: ${v.text}`);
      }
      const boxes = vals.flatMap((v) => [{ b: v.val, n: "valor " + v.text }, { b: v.lab, n: "rótulo " + v.text }]);
      for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
        for (const a of [vals[i].val, vals[i].lab]) for (const b of [vals[j].val, vals[j].lab]) {
          const inter = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
          if (inter) out.overlaps.push(`${sel}: "${vals[i].text}" x "${vals[j].text}"`);
        }
      }
    }
    return out;
  });
  return { page, r };
}

test("U17 dashboard: valor recebido e contagens NUNCA se sobrepõem nem saem do cartão (320–1440 px, com e sem financeiro)", async () => {
  const widths = [320, 360, 375, 390, 414, 768, 1024, 1440];
  for (const w of widths) for (const q of ["money=123456.78&today=12&up=148", "fin=0&today=128&up=1480", "money=0.5&today=0&up=0"]) {
    const { page, r } = await dashboardGeometry(w, q);
    assert.deepEqual(r.overlaps, [], `${w}px ${q}: sobreposição`);
    assert.deepEqual(r.escapes, [], `${w}px ${q}: valor fora do espaço`);
    assert.equal(r.hscroll, false, `${w}px ${q}: rolagem lateral`);
    if (q.startsWith("money=123456") && [320, 390, 768, 1440].includes(w)) await page.screenshot({ path: join(SHOTS, `30-dashboard-${w}.png`), fullPage: true });
    await page.close();
  }
});

test("U18 dashboard: 'Pendências' saiu; 'Próximos atendimentos' aparece com o período; carregando sem quebrar", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${PAGE}?view=dashboard&money=1500&up=7`);
  await page.waitForSelector('[data-testid="today-summary"]', { timeout: 6000 });
  const t = await page.$eval('[data-testid="today-summary"]', (e) => e.innerText);
  assert.doesNotMatch(t, /Pendências/);
  assert.match(t, /Próximos atendimentos/);
  assert.match(t, /nos próximos 7 dias/);
  assert.match(t, /Recebido hoje/);
  await page.goto(`${PAGE}?view=dashboard&loading=1`);
  await page.waitForSelector('[data-testid="today-summary"]', { timeout: 6000 });
  assert.ok(await noHorizontalScroll(page));
  await page.goto(`${PAGE}?view=kit`);
  await sleep(300);
  await page.screenshot({ path: join(SHOTS, "31-kit-390.png"), fullPage: true });
  await page.close();
});

// ============================================================ Mensagem de confirmação: sistema x própria (0027)
async function openTpl({ get, set: setReply = { data: { mode: "custom" }, error: null } } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 1100, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((cfg) => {
    window.__auto = { calls: [], ...cfg };
    window.__rpc = async (fn, args) => {
      window.__auto.calls.push({ fn, args });
      await new Promise((r) => setTimeout(r, 20));
      return fn === "wa_get_message_settings" ? window.__auto.get : window.__auto.set;
    };
  }, { get, set: setReply });
  await page.goto(`${PAGE}?view=msgtpl`);
  await page.waitForSelector('[data-testid="wa-confirmation-template"]', { timeout: 6000 });
  page.__errors = errors;
  return page;
}
const tplCard = (page) => page.$eval('[data-testid="wa-confirmation-template"]', (e) => e.innerText);

test("U19 mensagem de confirmação: padrão = sistema; minha mensagem com prévia ao vivo; variável errada impede salvar; salva certo", async () => {
  const page = await openTpl({ get: { data: { mode: "system", template: null, can_manage: true }, error: null } });
  assert.match(await tplCard(page), /Prévia \(um dos textos variados\)/);
  assert.match(await tplCard(page), /Oi, Ana/);
  const radios = await page.$$('input[name="confirmation-mode"]');
  await radios[1].click();
  await page.waitForSelector("textarea");
  assert.match(await tplCard(page), /Olá, Ana! Seu agendamento de Manicure está confirmado para sexta-feira, 16\/10, às 14h30\./);
  await page.click("textarea", { clickCount: 3 });
  await page.$eval("textarea", (e) => { e.focus(); e.select(); });
  await page.keyboard.type("Oi {nome}, {data} às {horario} {cupom}");
  await waitText(page, "Variável desconhecida: {cupom}.");
  const saveBtn = async () => page.$$eval("button", (bs) => bs.find((b) => b.innerText.trim() === "Salvar")?.disabled);
  assert.equal(await saveBtn(), true, "salvar desligado com variável desconhecida");
  for (let i = 0; i < " {cupom}".length; i++) await page.keyboard.press("Backspace");
  await sleep(100);
  assert.equal(await saveBtn(), false);
  assert.match(await tplCard(page), /Oi Ana, 16\/10 às 14h30/);
  await page.$$eval("button", (bs) => bs.find((b) => b.innerText.trim() === "Salvar").click());
  await waitText(page, "Salvo.");
  const sets = (await page.evaluate(() => window.__auto.calls)).filter((c) => c.fn === "wa_set_message_settings");
  assert.equal(sets.length, 1);
  assert.equal(sets[0].args.p_mode, "custom");
  assert.equal(sets[0].args.p_template.trim(), "Oi {nome}, {data} às {horario}");
  await page.screenshot({ path: join(SHOTS, "40-mensagem-propria.png"), fullPage: true });
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test("U20 mensagem de confirmação: profissional só vê (sem editar nem salvar)", async () => {
  const page = await openTpl({ get: { data: { mode: "custom", template: "Oi {nome}, {data} {horario}", can_manage: false }, error: null } });
  assert.equal(await page.$$eval('input[name="confirmation-mode"]', (r) => r.every((x) => x.disabled)), true);
  assert.equal(await page.$eval("textarea", (e) => e.disabled), true);
  assert.match(await tplCard(page), /Só a administração da empresa pode mudar/);
  assert.equal(await page.$$eval("button", (bs) => bs.some((b) => b.innerText.trim() === "Salvar")), false);
  await page.close();
});

// ============================================================ Relatórios: rankings
test("U21 rankings: 4 listas, top 5, nomes longos cortados com elegância, sem rolagem lateral (320–1024 px)", async () => {
  for (const w of [320, 390, 768, 1024]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 1400, deviceScaleFactor: 1 });
    await page.goto(`${PAGE}?view=rankings`);
    await page.waitForSelector('[data-testid="rank-clientes-frequencia"]', { timeout: 6000 });
    const r = await page.evaluate(() => {
      const ids = ["rank-servicos-realizados", "rank-servicos-faturamento", "rank-clientes-gasto", "rank-clientes-frequencia"];
      return ids.map((id) => {
        const card = document.querySelector(`[data-testid="${id}"]`);
        const cr = card.getBoundingClientRect();
        const lis = [...card.querySelectorAll("li")];
        const escapes = lis.filter((li) => [...li.querySelectorAll("p")].some((p) => p.getBoundingClientRect().right > cr.right - 8 || p.scrollWidth > p.clientWidth + 1 && !p.classList.contains("truncate"))).length;
        return { id, n: lis.length, first: lis[0]?.innerText.split("\n")[0], escapes };
      });
    });
    for (const x of r) { assert.equal(x.n, 5, `${w}px ${x.id} top 5`); assert.equal(x.escapes, 0, `${w}px ${x.id} conteúdo saindo do cartão`); }
    assert.match(r[0].first, /^1\.\s*Manicure/, "mais realizado = Manicure (31)");
    assert.match(r[1].first, /^1\.\s*Alongamento/, "mais faturamento = Alongamento (9 × 180 = 1.620 > Manicure 31 × 50 = 1.550)");
    assert.ok(await noHorizontalScroll(page), `${w}px rolagem lateral`);
    if (w === 390) await page.screenshot({ path: join(SHOTS, "50-rankings-390.png"), fullPage: true });
    await page.close();
  }
});

test("U22 interruptor: a bolinha fica DENTRO do trilho, ligado e desligado (320 e 1024 px)", async () => {
  for (const w of [320, 1024]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 600, deviceScaleFactor: 1 });
    await page.goto(`${PAGE}?view=switch`);
    await page.waitForSelector('[role="switch"]', { timeout: 6000 });
    const r = await page.$$eval('[role="switch"]', (els) => els.map((b) => {
      const t = b.getBoundingClientRect(); const k = b.querySelector("span").getBoundingClientRect();
      return { on: b.getAttribute("aria-checked") === "true", inside: k.left >= t.left && k.right <= t.right, nearRight: t.right - k.right < 4, nearLeft: k.left - t.left < 4 };
    }));
    for (const x of r) {
      assert.equal(x.inside, true, `${w}px ${x.on ? "ligado" : "desligado"}: bolinha fora do trilho`);
      assert.equal(x.on ? x.nearRight : x.nearLeft, true, `${w}px: bolinha no lado errado`);
    }
    if (w === 320) await page.screenshot({ path: join(SHOTS, "60-interruptor.png") });
    await page.close();
  }
});

// ============================================================ Mensagem de aniversário (0031)
async function openBday(get) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 1000, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((g) => {
    window.__b = { calls: [], get: g };
    window.__rpc = async (fn, args) => { window.__b.calls.push({ fn, args }); await new Promise((r) => setTimeout(r, 20));
      return fn === "wa_get_birthday_settings" ? window.__b.get : { data: { enabled: true }, error: null }; };
  }, get);
  await page.goto(`${PAGE}?view=birthday`);
  await page.waitForSelector('[data-testid="wa-birthday"]', { timeout: 6000 });
  page.__errors = errors;
  return page;
}

test("U23 aniversário: nasce desligado; liga + mensagem própria com prévia; variável errada impede salvar; salva certo", async () => {
  const page = await openBday({ data: { enabled: false, mode: "system", template: null, can_manage: true }, error: null });
  const card = () => page.$eval('[data-testid="wa-birthday"]', (e) => e.innerText);
  assert.match(await card(), /Mensagem de aniversário/);
  assert.match(await card(), /9h do dia do aniversário/);
  assert.match(await card(), /Ana/);
  assert.equal(await page.$eval('[role="switch"]', (b) => b.getAttribute("aria-checked")), "false");
  await page.click('[role="switch"]');
  const radios = await page.$$('input[name="birthday-mode"]');
  await radios[1].click();
  await page.waitForSelector("textarea");
  await page.$eval("textarea", (e) => { e.focus(); e.select(); });
  await page.keyboard.type("Parabéns, {nome}! {data}");
  await waitText(page, "Variável desconhecida: {data}.");
  const saveDisabled = () => page.$$eval("button", (bs) => bs.find((b) => b.innerText.trim() === "Salvar")?.disabled);
  assert.equal(await saveDisabled(), true);
  for (let i = 0; i < " {data}".length; i++) await page.keyboard.press("Backspace");
  await sleep(100);
  assert.equal(await saveDisabled(), false);
  assert.match(await card(), /Parabéns, Ana!/);
  await page.$$eval("button", (bs) => bs.find((b) => b.innerText.trim() === "Salvar").click());
  await waitText(page, "As mensagens de aniversário estão ligadas.");
  const sets = (await page.evaluate(() => window.__b.calls)).filter((c) => c.fn === "wa_set_birthday_settings");
  assert.equal(sets.length, 1);
  assert.deepEqual([sets[0].args.p_enabled, sets[0].args.p_mode, sets[0].args.p_template.trim()], [true, "custom", "Parabéns, {nome}!"]);
  await page.screenshot({ path: join(SHOTS, "70-aniversario.png"), fullPage: true });
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test("U24 aniversário: profissional só vê (interruptor e opções desabilitados, sem salvar)", async () => {
  const page = await openBday({ data: { enabled: true, mode: "system", template: null, can_manage: false }, error: null });
  assert.equal(await page.$eval('[role="switch"]', (b) => b.disabled), true);
  assert.equal(await page.$$eval('input[name="birthday-mode"]', (r) => r.every((x) => x.disabled)), true);
  assert.equal(await page.$$eval("button", (bs) => bs.some((b) => b.innerText.trim() === "Salvar")), false);
  await page.close();
});

test("U25 serviços adicionais: adicionar, escolher (valor/duração do cadastro), total certo, remover; sem estourar a 320 px", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 900, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${PAGE}?view=extras`);
  await page.waitForSelector('[data-testid="extra-services"]', { timeout: 6000 });
  const clickText = (t) => page.$$eval("button", (bs, t) => bs.find((b) => b.innerText.trim() === t).click(), t);
  await clickText("Adicionar outro serviço");
  await page.select("select", "s2");
  await waitText(page, "Total do atendimento");
  const t1 = await page.$eval('[data-testid="extra-total"]', (e) => e.innerText);
  assert.match(t1, /R\$\s*110,00/); assert.match(t1, /1h45/);
  await clickText("Adicionar outro serviço");
  const sels = await page.$$("select"); await sels[1].select("s3");
  await sleep(100);
  assert.match(await page.$eval('[data-testid="extra-total"]', (e) => e.innerText), /R\$\s*130,00.*2h/);
  assert.ok(await noHorizontalScroll(page), "rolagem lateral a 320 px");
  await page.screenshot({ path: join(SHOTS, "80-servicos-adicionais.png"), fullPage: true });
  await page.click('[aria-label="Remover serviço adicional 1"]');
  await sleep(100);
  assert.equal((await page.$$("select")).length, 1);
  assert.match(await page.$eval('[data-testid="extra-total"]', (e) => e.innerText), /R\$\s*70,00/);
  assert.deepEqual(errors, []);
  await page.close();
});

// ============================================================ Temas: Claro / Escuro / Automático
test("U26 aparência: escolher Escuro aplica o tema na hora e guarda no aparelho; Automático segue o celular", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${PAGE}?view=kit`);
  await page.waitForSelector('[data-testid="appearance"]', { timeout: 6000 });
  const pick = (t) => page.$$eval('[data-testid="appearance"] [role="radio"]', (bs, t) => bs.find((b) => b.innerText.startsWith(t)).click(), t);
  await pick("Escuro");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("aurea-theme")), "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, "rgb(28, 28, 30)", "fundo do tema Escuro (grafite) #1C1C1E");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await pick("Automático");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "light");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await pick("Automático");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  await pick("Claro");
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "light");
  assert.ok(await noHorizontalScroll(page));
  await page.close();
});

test("U27 tema Escuro: painel do início sem sobreposição em 320–1024 px", async () => {
  for (const w of [320, 390, 768, 1024]) {
    const { page, r } = await dashboardGeometry(w, "money=123456.78&today=12&up=148&theme=dark");
    assert.deepEqual(r.overlaps, [], `${w}px escuro: sobreposição`);
    assert.deepEqual(r.escapes, [], `${w}px escuro: fora do espaço`);
    assert.equal(r.hscroll, false);
    await page.close();
  }
});

// ============================================================ Persistência do tema (fechar e reabrir)
test("U28 tema PERSISTE: Escuro → fechar → (iPhone apaga o armazenamento local) → reabrir = Escuro; depois Claro idem", async () => {
  const http = await import("node:http"); const fs = await import("node:fs"); const path = await import("node:path");
  const root = path.join(process.cwd(), "dist");
  const srv = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/$/, "/index.html"));
    if (req.url.startsWith("/api/theme")) { res.writeHead(404); return res.end(); } // sem servidor real aqui: o cookie do navegador basta
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : f.endsWith(".css") ? "text/css" : "text/javascript" }); res.end(d); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/?view=kit`;
  const open = async () => { const p = await browser.newPage(); await p.setViewport({ width: 390, height: 800 }); await p.goto(url); await p.waitForSelector('[data-testid="appearance"]'); return p; };
  const theme = (p) => p.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const pick = (p, t) => p.$$eval('[data-testid="appearance"] [role="radio"]', (bs, t) => bs.find((b) => b.innerText.startsWith(t)).click(), t);
  try {
    let p = await open();
    assert.equal(await theme(p), "light", "nunca escolheu: claro");
    await pick(p, "Escuro");
    assert.equal(await theme(p), "dark");
    await p.evaluate(() => localStorage.clear());           // o iPhone apagou o armazenamento local
    await p.close();                                        // fechou o app
    p = await open();                                       // reabriu
    assert.equal(await theme(p), "dark", "reabriu no Escuro (cookie)");
    assert.equal(await p.$eval('[aria-checked="true"]', (b) => b.innerText.split("\n")[0]), "Escuro", "a opção marcada é a salva");
    await pick(p, "Claro");
    await p.close();
    p = await open();
    assert.equal(await theme(p), "light", "reabriu no Claro");
    await p.close();
  } finally {
    srv.close();
  }
});

test("U29 mensagens automáticas: 6 datas; liga na hora; personalizar com prévia ({anos}); variável errada bloqueia; 320 px", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 1100, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    window.__a = { calls: [] };
    const items = {}; for (const k of ["new_year","womens_day","selfcare_day","customer_day","christmas","client_anniversary"]) items[k] = { enabled: false, mode: "system", template: null };
    window.__rpc = async (fn, args) => { window.__a.calls.push({ fn, args }); await new Promise((r) => setTimeout(r, 20));
      if (fn === "wa_set_auto_message") items[args.p_kind] = { enabled: args.p_enabled, mode: args.p_mode, template: args.p_template };
      return { data: { can_manage: true, items }, error: null }; };
  });
  await page.goto(`${PAGE}?view=automsgs`);
  await page.waitForSelector('[data-testid="wa-auto"]', { timeout: 6000 });
  const text = await page.$eval('[data-testid="wa-auto"]', (e) => e.innerText);
  for (const t of ["Ano-Novo", "01/01", "Dia da Mulher", "08/03", "Dia do Autocuidado", "24/07", "Dia do Cliente", "15/09", "Natal", "25/12", "Aniversário de cliente"]) assert.ok(text.includes(t), t);
  const sw = await page.$$('[data-testid="wa-auto"] [role="switch"]'); assert.equal(sw.length, 6);
  await sw[4].click(); await waitText(page, "Natal: mensagem ligada.");
  const set = (await page.evaluate(() => window.__a.calls)).filter((c) => c.fn === "wa_set_auto_message");
  assert.deepEqual([set[0].args.p_kind, set[0].args.p_enabled], ["christmas", true]);
  const pers = await page.$$('[data-testid="wa-auto"] li button.text-xs'); await pers[5].click();
  await page.$$eval('[role="radio"]', (bs) => bs.find((b) => b.innerText === "Minha mensagem").click());
  await page.waitForSelector("textarea");
  await page.$eval("textarea", (e) => { e.focus(); e.select(); });
  await page.keyboard.type("Parabéns, {nome}! Hoje faz {anos} juntas. {cupom}");
  await waitText(page, "Variável desconhecida: {cupom}.");
  const saveDisabled = () => page.$$eval("button", (bs) => bs.find((b) => b.innerText.trim() === "Salvar")?.disabled);
  assert.equal(await saveDisabled(), true);
  for (let i = 0; i < " {cupom}".length; i++) await page.keyboard.press("Backspace");
  await waitText(page, "Parabéns, Ana! Hoje faz 2 anos juntas.");
  assert.equal(await saveDisabled(), false);
  assert.ok(await noHorizontalScroll(page), "rolagem lateral a 320 px");
  await page.screenshot({ path: join(SHOTS, "98-auto-mensagens.png"), fullPage: true });
  await page.close();
});

// ============================================================ Agenda: previsão do período (roadmap 0.1)
// Página REAL da Agenda com o banco em memória (window.__db) e o relógio parado
// em quinta, 05/11/2026, 13h em Brasília. Semana exibida: 02 a 08/11. Mês: novembro
// (a grade vai de 26/10 a 06/12, mas só os dias de novembro entram na previsão).
const NOTO = (await import("node:fs")).readFileSync(join(HERE, "../../public/fonts/noto-serif.woff2")).toString("base64");
const brt = (day, hm) => new Date(`2026-${day}T${hm}:00-03:00`).toISOString();
function agendaRows(big = false) {
  const v = (n) => (big ? 123456.78 : n);
  let n = 0;
  const a = (day, hm, status, price, member = "m1", client = "Carla Dias", service = "Alongamento em gel") => ({
    id: `a${++n}`, company_id: "00000000-0000-0000-0000-000000000001", scheduled_start: brt(day, hm),
    scheduled_end: new Date(Date.parse(brt(day, hm)) + 3600e3).toISOString(), status, price, professional_member_id: member,
    clients: { name: client }, services: { name: service },
  });
  if (big) return [a("11-05", "10:00", "concluido", v(0)), a("11-05", "15:00", "agendado", v(0))];
  return [
    a("11-05", "10:00", "concluido", 100, "m1", "Ana Paula", "Manicure"),
    a("11-05", "15:00", "agendado", 80.5, "m1", "Juliana Rocha", "Esmaltação em gel"),
    a("11-05", "16:00", "agendado", 70, "m2", "Fernanda Lopes", "Design de sobrancelha"),
    a("11-05", "12:00", "cancelado", 999, "m1", "Cancelada", "Manicure"),
    a("11-05", "09:00", "nao_compareceu", 999, "m1", "Faltou", "Manicure"),
    a("11-03", "14:00", "concluido", 60),
    a("11-07", "11:00", "confirmado", 120),
    a("11-08", "23:30", "agendado", 40),   // domingo 23h30 em Brasília: ainda é desta semana
    a("11-01", "10:00", "concluido", 150), // domingo 01/11: do mês, mas da semana anterior
    a("11-20", "10:00", "agendado", 200),
    a("10-30", "10:00", "agendado", 500),  // na grade de novembro, fora do mês
    a("12-02", "10:00", "agendado", 300),  // na grade de novembro, fora do mês
  ];
}
async function openAgenda({ role = "owner", width = 390, height = 900, theme = "", big = false, forecastDelay = 20, failForecast = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateTimezone("America/Sao_Paulo");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((rows, forecastDelay, failForecast) => {
    // relógio parado em 05/11/2026 13h (Brasília), andando a partir daí
    const R = Date, fixed = R.parse("2026-11-05T13:00:00-03:00"), t0 = R.now();
    class D extends R { constructor(...a) { if (a.length === 0) super(fixed + (R.now() - t0)); else super(...a); } static now() { return fixed + (R.now() - t0); } }
    window.Date = D;
    const isForecast = (c) => c.table === "appointments" && c.select.includes("price");
    window.__db = {
      tables: {
        appointments: rows,
        company_members: [
          { id: "m1", role: "owner", active: true, company_id: "00000000-0000-0000-0000-000000000001" },
          { id: "m2", role: "professional", active: true, company_id: "00000000-0000-0000-0000-000000000001" },
        ],
      },
      rpc: { get_company_member_names: [{ member_id: "m1", full_name: "Ana Lima" }, { member_id: "m2", full_name: "Bia Rocha" }] },
      calls: [],
      delay: (c) => (isForecast(c) ? forecastDelay : 20),
      fail: (c) => failForecast && isForecast(c),
    };
  }, agendaRows(big), forecastDelay, failForecast);
  await page.goto(`${PAGE}?view=agenda&role=${role}${theme ? `&theme=${theme}` : ""}`);
  // fonte real do app (Noto Serif de public/fonts), para medir larguras de verdade
  await page.addStyleTag({ content: `@font-face{font-family:"Noto Serif";src:url(data:font/woff2;base64,${NOTO}) format("woff2");font-weight:400 700}:root{--font-sans:"Noto Serif",Georgia,serif;--font-serif:"Noto Serif",Georgia,serif}` });
  await page.evaluate(() => document.fonts.ready);
  page.errors = errors;
  return page;
}
const norm = (s) => s.replace(/\s+/g, " ").trim();
const forecastText = (page) => page.$eval('[data-testid="agenda-forecast"]', (e) => e.innerText).then(norm);
const waitForecast = (page) => page.waitForFunction(() => document.querySelector('[data-testid="agenda-forecast-value"]'), { timeout: 6000 });
const pickView = (page, label) =>
  page.evaluate((l) => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === l).click(), label);
const waitValue = (page, v) =>
  page.waitForFunction((v) => document.querySelector('[data-testid="agenda-forecast-value"]')?.innerText.replace(/\s+/g, " ") === v, { timeout: 6000 }, v);
const pressNav = (page, aria) => page.$eval(`button[aria-label="${aria}"]`, (b) => b.click());

test("U30 Agenda: previsão do período exibido no Dia, na Semana e no Mês; setas, Hoje e filtro de profissional", async () => {
  const page = await openAgenda();
  await waitForecast(page);
  // Dia 05/11: 100 concluído + 80,50 + 70 em aberto; cancelado e falta fora
  assert.equal(await forecastText(page), "Previsto R$ 250,50 R$ 100,00 realizado · R$ 150,50 agendado");
  // Semana 02 a 08/11 (inclui domingo 23h30; não inclui 01/11)
  await pickView(page, "Semana");
  await waitValue(page, "R$ 470,50");
  assert.equal(await forecastText(page), "Previsto R$ 470,50 R$ 160,00 realizado · R$ 310,50 agendado");
  // Mês: só novembro (30/10 e 02/12 estão na grade, mas fora do mês)
  await pickView(page, "Mês");
  await waitValue(page, "R$ 820,50");
  assert.equal(await forecastText(page), "Previsto R$ 820,50 R$ 310,00 realizado · R$ 510,50 agendado");
  // setas: dezembro só tem o de 02/12; outubro só o de 30/10
  await pressNav(page, "Próximo");
  await waitValue(page, "R$ 300,00");
  await pressNav(page, "Anterior");
  await pressNav(page, "Anterior");
  await waitValue(page, "R$ 500,00");
  // Hoje volta para novembro
  await clickButton(page, "Hoje");
  await waitValue(page, "R$ 820,50");
  // semana seguinte vazia: R$ 0,00
  await pickView(page, "Semana");
  await waitValue(page, "R$ 470,50");
  await pressNav(page, "Próximo");
  await waitValue(page, "R$ 0,00");
  assert.equal(await forecastText(page), "Previsto R$ 0,00 R$ 0,00 realizado · R$ 0,00 agendado");
  await clickButton(page, "Hoje");
  await waitValue(page, "R$ 470,50");
  // filtro de profissional (há duas): Ana tira os 70 da Bia
  await pickView(page, "Dia");
  await waitValue(page, "R$ 250,50");
  await page.select("select", "m1");
  await waitValue(page, "R$ 180,50");
  await page.select("select", "m2");
  await waitValue(page, "R$ 70,00");
  await page.select("select", "all");
  await waitValue(page, "R$ 250,50");
  // a consulta da previsão é leve, só com os status que entram na conta e limites em Brasília
  const calls = (await page.evaluate(() => window.__db.calls)).filter((c) => c.select.includes("price"));
  assert.ok(calls.every((c) => c.select === "price, status, scheduled_start"));
  const last = calls.at(-1).filters;
  assert.deepEqual(last.find((f) => f[0] === "in")[2], ["concluido", "agendado", "confirmado", "em_atendimento"]);
  assert.equal(last.find((f) => f[0] === "gte")[2], "2026-11-05T00:00:00-03:00");
  assert.equal(last.find((f) => f[0] === "lte")[2], "2026-11-05T23:59:59.999-03:00");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("U31 Agenda: a faixa cabe de 320 a 1440 px nos dois temas, com R$ 123.456,78, e o esqueleto tem o mesmo tamanho", async () => {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 390, 768, 1440]) {
      const page = await openAgenda({ width, theme, big: true, forecastDelay: 400 });
      await page.waitForSelector('[data-testid="agenda-forecast"][aria-busy="true"]', { timeout: 6000 });
      const box = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; });
      const loading = await box('[data-testid="agenda-forecast"]');
      for (const label of ["Dia", "Semana", "Mês"]) {
        await pickView(page, label);
        await page.waitForFunction(() => document.querySelector('[data-testid="agenda-forecast"]')?.getAttribute("aria-busy") === "false", { timeout: 6000 });
        const tag = `${theme} ${width}px ${label}`;
        assert.equal(await forecastText(page), "Previsto R$ 246.913,56 R$ 123.456,78 realizado · R$ 123.456,78 agendado", tag);
        assert.ok(await noHorizontalScroll(page), `rolagem lateral: ${tag}`);
        const f = await box('[data-testid="agenda-forecast"]');
        assert.ok(f.l >= 0 && f.r <= width, `faixa fora da tela: ${tag} ${JSON.stringify(f)}`);
        // nenhum texto da faixa cortado ou passando do contêiner
        const overflow = await page.$$eval('[data-testid="agenda-forecast"] *', (els) =>
          els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > document.documentElement.clientWidth).map((e) => e.innerText));
        assert.deepEqual(overflow, [], tag);
        // a faixa fica entre a navegação de datas e o conteúdo, sem sobrepor
        const nav = await page.$eval('button[aria-label="Anterior"]', (e) => e.parentElement.parentElement.getBoundingClientRect().bottom);
        const content = await page.$eval('[data-testid="agenda-forecast"]', (e) => e.parentElement.nextElementSibling.getBoundingClientRect().top);
        assert.ok(nav <= f.t + 0.5 && f.b <= content + 0.5, `sobreposição: ${tag}`);
        assert.equal(f.h, loading.h, `esqueleto e valor com alturas diferentes: ${tag}`);
      }
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  }
  // valores comuns: o esqueleto tem exatamente a altura da faixa carregada (a tela não pula)
  const page = await openAgenda({ width: 320, forecastDelay: 400 });
  await page.waitForSelector('[data-testid="agenda-forecast"][aria-busy="true"]');
  const top0 = await page.$eval('[data-testid="agenda-forecast"]', (e) => e.parentElement.nextElementSibling.getBoundingClientRect().top);
  await waitForecast(page);
  const top1 = await page.$eval('[data-testid="agenda-forecast"]', (e) => e.parentElement.nextElementSibling.getBoundingClientRect().top);
  assert.equal(top1, top0, "o conteúdo da agenda não pode mudar de lugar quando a previsão chega");
  await page.close();
});

test("U32 Agenda: quem não vê o financeiro (profissional, recepção) não vê a faixa nem consulta valores; falha não inventa R$ 0,00", async () => {
  for (const role of ["professional", "reception"]) {
    const page = await openAgenda({ role });
    await page.waitForFunction(() => document.body.innerText.includes("Ana Paula"), { timeout: 6000 });
    for (const label of ["Dia", "Semana", "Mês"]) {
      await pickView(page, label);
      await sleep(150);
      assert.equal(await page.$('[data-testid="agenda-forecast"]'), null, `${role} ${label}`);
      assert.ok(!(await text(page)).includes("Previsto"), `${role} ${label}`);
    }
    const calls = await page.evaluate(() => window.__db.calls);
    assert.ok(calls.length > 0 && calls.every((c) => !c.select.includes("price")), `${role}: nenhuma consulta de valores`);
    assert.deepEqual(page.errors, []);
    await page.close();
  }
  for (const role of ["owner", "admin"]) {
    const page = await openAgenda({ role });
    await waitForecast(page);
    await page.close();
  }
  const page = await openAgenda({ failForecast: true });
  await page.waitForFunction(() => document.body.innerText.includes("Não foi possível calcular agora."), { timeout: 6000 });
  assert.ok(!(await forecastText(page)).includes("R$"), "sem valor inventado quando a consulta falha");
  await page.close();
});

test("U33 Agenda: capturas a 390 px (Dia, Semana e Mês) nos temas claro e escuro", async () => {
  for (const theme of ["light", "dark"]) {
    const page = await openAgenda({ width: 390, height: 844, theme });
    for (const [label, file] of [["Dia", "dia"], ["Semana", "semana"], ["Mês", "mes"]]) {
      await pickView(page, label);
      await waitValue(page, { Dia: "R$ 250,50", Semana: "R$ 470,50", "Mês": "R$ 820,50" }[label]);
      await sleep(100);
      await page.screenshot({ path: join(SHOTS, `agenda-${file}-390-${theme === "dark" ? "escuro" : "claro"}.png`) });
    }
    await page.close();
  }
});

// ============================================================ Mais > Assinatura (0051)
// Página REAL. my_subscription e a função account-billing simuladas em window.__db.
const SUB_ACTIVE = {
  status: "active", amount: 59.9, trial_ends_at: "2026-10-08T15:00:00Z", next_payment_at: "2026-12-01T15:00:00Z", canceled_at: null,
  access: { status: "active", allowed: true, warning: false }, can_cancel: true, cancel_pending: false,
  payments: [
    { at: "2026-12-01T15:00:00Z", status: "scheduled", amount: 59.9, refunded: 0 },
    { at: "2026-11-01T15:00:00Z", status: "approved", amount: 59.9, refunded: 0 },
    { at: "2026-10-08T15:00:00Z", status: "rejected", amount: 59.9, refunded: 0 },
  ],
};
const SUB_ENDING = { ...SUB_ACTIVE, status: "canceled", can_cancel: false, next_payment_at: null,
  access: { status: "ending", allowed: true, warning: true, until: "2026-12-01T15:00:00Z" } };
async function openAssinatura({ role = "owner", sub = SUB_ACTIVE, fnStatus = 200, fnError = "", width = 390, height = 900, theme = "" } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateTimezone("America/Sao_Paulo");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((sub, ending, fnStatus, fnError) => {
    let cancelled = false;
    window.__db = {
      tables: {}, calls: [],
      rpc: { my_subscription: () => ({ data: cancelled ? ending : sub, error: null }) },
      invoke: (name, body) => {
        if (fnStatus === 200) { cancelled = true; return { data: { ok: true }, error: null }; }
        const context = new Response(JSON.stringify({ error: fnError }), { status: fnStatus });
        return { data: null, error: { message: "Edge Function returned a non-2xx status code", context } };
      },
    };
  }, sub, SUB_ENDING, fnStatus, fnError);
  await page.goto(`${PAGE}?view=assinatura&role=${role}${theme ? `&theme=${theme}` : ""}`);
  await page.addStyleTag({ content: `@font-face{font-family:"Noto Serif";src:url(data:font/woff2;base64,${NOTO}) format("woff2");font-weight:400 700}:root{--font-sans:"Noto Serif",Georgia,serif;--font-serif:"Noto Serif",Georgia,serif}` });
  await page.evaluate(() => document.fonts.ready);
  page.errors = errors;
  return page;
}

test("U34 Assinatura: a dona vê situação, valor, próxima cobrança e o histórico; cancela com motivo e vê até quando continua", async () => {
  const page = await openAssinatura();
  await waitText(page, "Assinatura ativa");
  const t = norm(await text(page));
  assert.ok(t.includes("Próxima cobrança de R$ 59,90 em 01/12/2026."), t);
  assert.ok(t.includes("R$ 59,90 /mês"));
  for (const s of ["Agendada", "Paga", "Recusada", "01/11/2026", "08/10/2026"]) assert.ok(t.includes(s), s);
  assert.ok(t.includes("Trocar forma de pagamento"));
  // cancelar: aviso, motivo opcional, chamada com a empresa e o motivo
  await clickButton(page, "Cancelar assinatura");
  await waitText(page, "Não haverá novas cobranças. Você continua usando a Sócia até o fim do mês que já foi pago.");
  await clickButton(page, "Está caro para mim agora");
  await page.type("textarea", "Volto em março");
  const buttons = await page.$$eval('[role="dialog"] button, .fixed button', (b) => b.map((x) => x.innerText.trim()));
  assert.ok(buttons.includes("Continuar com a Sócia"));
  await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.innerText.trim() === "Cancelar assinatura").at(-1).click());
  await waitText(page, "Você continua usando a Sócia até 01/12/2026.");
  const call = (await page.evaluate(() => window.__db.calls)).find((c) => c.table === "fn:account-billing");
  assert.deepEqual(call.filters[0][2], { action: "cancel", company_id: "00000000-0000-0000-0000-000000000001", reason: "Está caro para mim agora — Volto em março" });
  const t2 = norm(await text(page));
  assert.ok(t2.includes("Assinatura cancelada. Não haverá novas cobranças."), "toast");
  assert.ok(!t2.includes("Trocar forma de pagamento"), "sem trocar pagamento depois de cancelar");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Cancelar assinatura")), false);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("U35 Assinatura: erro do Mercado Pago aparece no modal; teste grátis avisa que o acesso para; equipe e cortesia não cancelam", async () => {
  let page = await openAssinatura({ fnStatus: 502, fnError: "O Mercado Pago não confirmou o cancelamento. Tente de novo em alguns minutos." });
  await waitText(page, "Assinatura ativa");
  await clickButton(page, "Cancelar assinatura");
  await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.innerText.trim() === "Cancelar assinatura").at(-1).click());
  await waitText(page, "O Mercado Pago não confirmou o cancelamento.");
  assert.ok(norm(await text(page)).includes("Assinatura ativa"), "continua ativa");
  await page.close();

  page = await openAssinatura({ sub: { ...SUB_ACTIVE, status: "trialing", trial_ends_at: "2026-11-15T15:00:00Z", next_payment_at: "2026-11-15T15:00:00Z", payments: [] } });
  await waitText(page, "Teste grátis");
  assert.ok(norm(await text(page)).includes("O teste vai até 15/11/2026. Nada é cobrado até lá."));
  assert.ok(!norm(await text(page)).includes("Cobranças"), "sem histórico vazio");
  await clickButton(page, "Cancelar assinatura");
  await waitText(page, "o acesso é pausado assim que o Mercado Pago confirmar");
  await page.close();

  for (const role of ["admin", "professional", "reception"]) {
    page = await openAssinatura({ role });
    await waitText(page, "Só a dona da conta vê e muda a assinatura.");
    assert.equal((await page.evaluate(() => window.__db.calls)).some((c) => c.table === "rpc:my_subscription"), false, `${role} não consulta`);
    await page.close();
  }

  page = await openAssinatura({ sub: { ...SUB_ACTIVE, status: "free", amount: null, can_cancel: false, payments: [] } });
  await waitText(page, "Cortesia");
  const t = norm(await text(page));
  assert.ok(!t.includes("Cancelar assinatura") && !t.includes("Trocar forma de pagamento") && !t.includes("/mês"));
  await page.close();
});

test("U36 Assinatura: cabe de 320 a 1440 px nos dois temas, com e sem o modal aberto; capturas a 390 px", async () => {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 390, 768, 1440]) {
      const page = await openAssinatura({ width, theme });
      await waitText(page, "Assinatura ativa");
      assert.ok(await noHorizontalScroll(page), `rolagem lateral ${theme} ${width}`);
      if (width === 390) await page.screenshot({ path: join(SHOTS, `assinatura-390-${theme === "dark" ? "escuro" : "claro"}.png`), fullPage: true });
      await clickButton(page, "Cancelar assinatura");
      await waitText(page, "Se puder, conte o motivo");
      assert.ok(await noHorizontalScroll(page), `rolagem lateral com modal ${theme} ${width}`);
      if (width === 390) { await sleep(500); await page.screenshot({ path: join(SHOTS, `assinatura-cancelar-390-${theme === "dark" ? "escuro" : "claro"}.png`) }); }
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  }
});

// ============================================================ Cadastro do teste sem cartão (0052)
async function openCadastro({ query = "", width = 390, height = 900, theme = "", invoke = "ok" } = {}) {
  const fs = await import("node:fs");
  for (const f of ["logo-lockup.png", "logo-lockup-dark.png"]) {
    const dst = join(HERE, "dist", f);
    if (!fs.existsSync(dst)) fs.copyFileSync(join(HERE, "../../public", f), dst);
  }
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.nav = null;
  page.reported = [];
  // A navegação final troca o documento; o que a página chamou é registrado aqui, no Node.
  await page.exposeFunction("__report", (x) => page.reported.push(JSON.parse(x)));
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && /\/(onboarding|login)$/.test(r.url())) { page.nav = r.url(); r.abort(); }
    else r.continue();
  });
  await page.evaluateOnNewDocument((invoke) => {
    window.__db = {
      tables: {}, calls: [],
      signIn: (creds) => { window.__report(JSON.stringify({ kind: "signIn", creds })); return { data: {}, error: null }; },
      invoke: (name, body) => {
        window.__report(JSON.stringify({ kind: "invoke", name, body }));
        if (invoke === "ok") return { data: { ok: true, trial_ends_at: "2026-11-16T12:00:00Z" }, error: null };
        const status = invoke === "exists" ? 409 : 500;
        const msg = invoke === "exists" ? "Este e-mail já tem conta na Sócia. Entre com a sua senha." : "Não foi possível criar a conta agora. Tente de novo.";
        return { data: null, error: { message: "non-2xx", context: new Response(JSON.stringify({ error: msg, code: invoke === "exists" ? "23505" : undefined }), { status }) } };
      },
    };
  }, invoke);
  await page.goto(`${PAGE}?view=cadastro${theme ? `&theme=${theme}` : ""}${query}`);
  await page.addStyleTag({ content: `@font-face{font-family:"Noto Serif";src:url(data:font/woff2;base64,${NOTO}) format("woff2");font-weight:400 700}:root{--font-sans:"Noto Serif",Georgia,serif;--font-serif:"Noto Serif",Georgia,serif}` });
  await page.evaluate(() => document.fonts.ready);
  page.errors = errors;
  return page;
}

test("U37 Cadastro sem cartão: preenche pela landing, valida a senha, cria a conta, entra e vai para o onboarding", async () => {
  const page = await openCadastro({ query: "&email=ana%40exemplo.com&nome=Ana&utm_source=instagram&utm_campaign=reel" });
  await waitText(page, "Teste grátis por 7 dias");
  const t = norm(await text(page));
  assert.ok(t.includes("Sem cartão de crédito. Depois, R$ 59,90 por mês, se quiser continuar."), t);
  assert.equal(await page.$eval('input[type="email"]', (e) => e.value), "ana@exemplo.com");
  assert.equal(await page.$eval('input[autocomplete="name"]', (e) => e.value), "Ana");
  // senha curta: mensagem na tela, sem chamar a função
  await page.type('input[type="password"]', "1234567");
  await clickButton(page, "Começar meu teste grátis");
  await waitText(page, "A senha precisa ter pelo menos 8 caracteres.");
  assert.equal((await page.evaluate(() => window.__db.calls)).length, 0);
  await page.type('input[type="password"]', "8");
  await clickButton(page, "Começar meu teste grátis");
  for (let i = 0; i < 80 && !page.nav; i++) await sleep(50);
  const inv = page.reported.find((r) => r.kind === "invoke");
  assert.equal(inv.name, "trial-signup");
  assert.deepEqual(inv.body, { name: "Ana", email: "ana@exemplo.com", password: "12345678", utm: { utm_source: "instagram", utm_campaign: "reel" }, website: "" });
  assert.deepEqual(page.reported.find((r) => r.kind === "signIn").creds, { email: "ana@exemplo.com", password: "12345678" });
  assert.ok(page.nav && page.nav.endsWith("/onboarding"), `foi para ${page.nav}`);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("U38 Cadastro sem cartão: e-mail com conta mostra o motivo e o link Entrar; cabe de 320 a 1440 px nos dois temas", async () => {
  let page = await openCadastro({ invoke: "exists" });
  await waitText(page, "Teste grátis por 7 dias");
  await page.type('input[autocomplete="name"]', "Bia");
  await page.type('input[type="email"]', "bia@x.com");
  await page.type('input[type="password"]', "senha-forte");
  await clickButton(page, "Começar meu teste grátis");
  await waitText(page, "Este e-mail já tem conta na Sócia. Entre com a sua senha.");
  assert.equal(await page.$eval('[role="alert"] a', (a) => a.getAttribute("href")), "/login");
  assert.equal(page.reported.some((r) => r.kind === "signIn"), false);
  await page.close();
  page = await openCadastro({ invoke: "falha" });
  await page.type('input[autocomplete="name"]', "Bia");
  await page.type('input[type="email"]', "bia@x.com");
  await page.type('input[type="password"]', "senha-forte");
  await clickButton(page, "Começar meu teste grátis");
  await waitText(page, "Não foi possível criar a conta agora.");
  assert.equal(await page.$('[role="alert"] a'), null, "sem link Entrar em erro comum");
  await page.close();
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 390, 768, 1440]) {
      page = await openCadastro({ width, theme });
      await waitText(page, "Teste grátis por 7 dias");
      assert.ok(await noHorizontalScroll(page), `rolagem lateral ${theme} ${width}`);
      if (width === 390) await page.screenshot({ path: join(SHOTS, `cadastro-390-${theme === "dark" ? "escuro" : "claro"}.png`), fullPage: true });
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  }
});
