// W3 — lógica pura e controlador da tela de WhatsApp, com relógio falso e API
// simulada (as RPCs reais são testadas no banco em supabase/tests/0017_*).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load-ts.cjs");
const wa = load("lib/hive/whatsapp.ts");
const { WhatsappController } = load("lib/hive/whatsapp-controller.ts");

// ---------------------------------------------------------------- relógio falso
function fakeClock(start = 1_000_000) {
  let now = start;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const h = ++id;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout(h) {
      timers.delete(h);
    },
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      await flush();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const st = (status, extra = {}) => ({
  data: { status, can_manage: true, can_send: status === "connected", qr_available: status === "qr_pending", ...extra },
});

function fakeApi(script = {}) {
  const calls = { getStatus: 0, getQr: 0, requestConnection: 0, disconnect: 0 };
  const api = {
    calls,
    status: st("disconnected"),
    qr: { data: { qr: null } },
    request: { data: { status: "connect_requested" } },
    disc: { data: { status: "disconnect_requested" } },
    async getStatus() {
      calls.getStatus++;
      return typeof api.status === "function" ? api.status() : api.status;
    },
    async getQr() {
      calls.getQr++;
      return typeof api.qr === "function" ? api.qr() : api.qr;
    },
    async requestConnection() {
      calls.requestConnection++;
      return api.request;
    },
    async disconnect() {
      calls.disconnect++;
      return api.disc;
    },
    ...script,
  };
  return api;
}

function setup({ role = "owner", api = fakeApi() } = {}) {
  const clock = fakeClock();
  const states = [];
  const c = new WhatsappController(api, { clock, role, onChange: (s) => states.push(s) });
  return { c, clock, api, states };
}

// ------------------------------------------------------------------ lógica pura
test("parseStatus aceita só respostas válidas; nada é inventado", () => {
  assert.equal(wa.parseStatus(null), null);
  assert.equal(wa.parseStatus({ status: "hackeado" }), null);
  assert.equal(wa.parseStatus([{ status: "connected" }]), null);
  const s = wa.parseStatus({ status: "connected", phone: "5511987654321", can_manage: "true" });
  assert.equal(s.status, "connected");
  assert.equal(s.canManage, false, "só true literal libera gestão");
});

test("parseQr exige texto de QR e validade parseável", () => {
  assert.equal(wa.parseQr({ qr: null }), null);
  assert.equal(wa.parseQr({ qr: "curto", expires_at: new Date().toISOString() }), null);
  assert.equal(wa.parseQr({ qr: "2@abcdefghijk", expires_at: "amanhã" }), null);
  assert.ok(wa.parseQr({ qr: "2@abcdefghijk", expires_at: new Date().toISOString() }));
});

test("cada estado tem rótulo e tom próprios; os cinco pedidos estão claros", () => {
  const labels = {
    connect_requested: "Preparando conexão",
    qr_pending: "Aguardando leitura do QR",
    connecting: "Conectando",
    connected: "Conectado",
    disconnected: "Desconectado",
    error: "Erro na conexão",
    stale: "Sem sinal",
    logged_out: "Desconectado pelo celular",
  };
  for (const [s, l] of Object.entries(labels)) assert.equal(wa.describeStatus(s).label, l, s);
  assert.equal(wa.describeStatus("connected").tone, "success");
  assert.equal(wa.describeStatus("error").tone, "danger");
  assert.match(wa.describeStatus("error", { lastError: "Sessão aberta em outro lugar." }).description, /outro lugar/);
  assert.match(wa.describeStatus("connect_requested", { workerSlow: true }).description, /não respondeu/);
  assert.match(wa.describeStatus("qr_pending", { canManage: false }).description, /administração da empresa está conectando/);
  assert.match(wa.describeStatus("qr_pending", { canManage: true }).description, /código abaixo/);
});

test("ações por papel: só owner/admin (e can_manage do banco) conectam, desconectam e veem o QR", () => {
  for (const role of ["professional", "reception"]) {
    const a = wa.availableActions("qr_pending", true, role);
    assert.deepEqual(a, { connect: false, disconnect: false, showQr: false }, role);
  }
  assert.deepEqual(wa.availableActions("qr_pending", false, "owner"), { connect: false, disconnect: false, showQr: false });
  assert.equal(wa.availableActions("qr_pending", true, "admin").showQr, true);
  assert.equal(wa.availableActions("disconnected", true, "owner").connect, true);
  assert.equal(wa.availableActions("connected", true, "owner").connect, false);
  assert.equal(wa.availableActions("connected", true, "owner").disconnect, true);
  assert.equal(wa.availableActions("disconnect_requested", true, "owner").disconnect, false);
});

test("ritmo de atualização: rápido no meio do processo, lento quando estável, recuo em falha, pausa escondida", () => {
  assert.equal(wa.nextPollMs("qr_pending", { visible: true, failures: 0 }), 2000);
  assert.equal(wa.nextPollMs("connected", { visible: true, failures: 0 }), 15000);
  assert.equal(wa.nextPollMs("connected", { visible: false, failures: 0 }), null);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((f) => wa.nextPollMs("connected", { visible: true, failures: f })), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test("validade do QR: no máximo 60 s a partir do recebimento, mesmo com relógio do aparelho errado", () => {
  const t = 1_000_000;
  assert.equal(wa.qrLocalDeadline(new Date(t + 60000).toISOString(), t), t + 60000);
  assert.equal(wa.qrLocalDeadline(new Date(t + 10 * 60000).toISOString(), t), t + 60000, "relógio atrasado não estica");
  assert.equal(wa.qrLocalDeadline(new Date(t - 30000).toISOString(), t), t + 5000, "relógio adiantado não zera");
  assert.equal(wa.qrSecondsLeft(t + 60000, t), 60);
  assert.equal(wa.qrSecondsLeft(t + 60000, t + 59001), 1);
  assert.equal(wa.qrSecondsLeft(t + 60000, t + 60000), 0);
});

test("erros das RPCs: integração ausente, permissão, sessão e rede têm mensagens próprias", () => {
  assert.equal(wa.classifyRpcError({ code: "PGRST202" }), "unavailable");
  assert.equal(wa.classifyRpcError({ code: "42883" }), "unavailable");
  assert.equal(wa.classifyRpcError({ code: "42501" }), "forbidden");
  assert.equal(wa.classifyRpcError({ code: "28000" }), "session");
  assert.equal(wa.classifyRpcError({ message: "TypeError: Failed to fetch" }), "network");
  assert.equal(wa.classifyRpcError({ code: "XX000", message: "boom" }), "unknown");
});

test("número conectado formatado para leitura", () => {
  assert.equal(wa.formatConnectedPhone("5511987654321"), "(11) 98765-4321");
  assert.equal(wa.formatConnectedPhone(null), null);
});

// ------------------------------------------------------------------ controlador
test("C1 carrega o status e agenda a próxima consulta conforme o estado", async () => {
  const { c, clock, api } = setup();
  api.status = st("connected", { phone: "5511987654321" });
  c.start();
  await clock.advance(0);
  assert.equal(c.state.phase, "ready");
  assert.equal(c.state.snapshot.status, "connected");
  assert.deepEqual(clock.pending(), [15000]);
  await clock.advance(15000);
  assert.equal(api.calls.getStatus, 2);
});

test("C2 conectar: mostra 'pedido enviado', nunca 'conectado' sem o banco confirmar", async () => {
  const { c, clock, api } = setup();
  c.start();
  await clock.advance(0);
  api.status = st("connect_requested");
  await c.connect();
  assert.equal(api.calls.requestConnection, 1);
  assert.equal(c.state.snapshot.status, "connect_requested");
  assert.match(c.state.notice, /Pedido de conexão enviado/);
  assert.notEqual(c.state.snapshot.status, "connected");
  assert.deepEqual(clock.pending()[0], 2000, "atualização rápida durante a conexão");
});

test("C3 QR: owner recebe o QR; ele some ao vencer e a tela pede o próximo", async () => {
  const { c, clock, api } = setup();
  api.status = st("qr_pending");
  api.qr = () => ({ data: { qr: "2@QR-UM-xxxxxxxx", expires_at: new Date(clock.now() + 60000).toISOString() } });
  c.start();
  await clock.advance(0);
  assert.equal(c.state.qr.value, "2@QR-UM-xxxxxxxx");
  // o banco deixa de devolver QR (venceu lá também) e o tempo passa
  api.qr = { data: { qr: null } };
  await clock.advance(60000);
  assert.equal(c.state.qr, null, "QR vencido não fica na tela");
  // chega um QR novo
  api.qr = () => ({ data: { qr: "2@QR-DOIS-xxxxxxx", expires_at: new Date(clock.now() + 60000).toISOString() } });
  await clock.advance(2000);
  assert.equal(c.state.qr.value, "2@QR-DOIS-xxxxxxx");
});

test("C4 QR igual em consultas seguidas não reinicia a contagem", async () => {
  const { c, clock, api } = setup();
  api.status = st("qr_pending");
  api.qr = () => ({ data: { qr: "2@QR-FIXO-xxxxxxx", expires_at: new Date(1_000_000 + 60000).toISOString() } });
  c.start();
  await clock.advance(0);
  const d1 = c.state.qr.deadline;
  await clock.advance(10000);
  assert.equal(c.state.qr.deadline, d1);
});

test("C5 profissional/recepção: consulta o status, NUNCA busca o QR nem vê ações", async () => {
  for (const role of ["professional", "reception"]) {
    const api = fakeApi();
    api.status = st("qr_pending", { can_manage: false, qr_available: false });
    const { c, clock } = setup({ role, api });
    c.start();
    await clock.advance(10000);
    assert.equal(api.calls.getQr, 0, role);
    assert.equal(c.state.qr, null);
    assert.ok(api.calls.getStatus >= 2);
  }
});

test("C6 mesmo que o banco diga can_manage, papel local de profissional não busca QR (vale o mais restritivo)", async () => {
  const api = fakeApi();
  api.status = st("qr_pending");
  const { c, clock } = setup({ role: "professional", api });
  c.start();
  await clock.advance(5000);
  assert.equal(api.calls.getQr, 0);
});

test("C7 banco/rede fora: mantém o último estado, avisa que pode estar desatualizado e tenta com espera crescente", async () => {
  const { c, clock, api } = setup();
  api.status = st("connected");
  c.start();
  await clock.advance(0);
  api.status = { error: { message: "TypeError: Failed to fetch" } };
  await clock.advance(15000);
  assert.equal(c.state.phase, "ready");
  assert.equal(c.state.snapshot.status, "connected", "último estado conhecido preservado");
  assert.match(c.state.refreshError, /Sem conexão/);
  assert.deepEqual(clock.pending(), [5000]);
  await clock.advance(5000);
  assert.deepEqual(clock.pending(), [10000]);
  api.status = st("connected");
  await clock.advance(10000);
  assert.equal(c.state.refreshError, null);
  assert.equal(c.state.failures, 0);
});

test("C8 primeira consulta falha: estado de erro (sem estado inventado) e nova tentativa", async () => {
  const { c, clock, api } = setup();
  api.status = { error: { code: "XX000", message: "boom" } };
  c.start();
  await clock.advance(0);
  assert.equal(c.state.phase, "error");
  assert.equal(c.state.snapshot, null);
  api.status = st("disconnected");
  await clock.advance(5000);
  assert.equal(c.state.phase, "ready");
});

test("C9 a 0017 ainda não aplicada: 'indisponível' e para de consultar (sem martelar o banco)", async () => {
  const { c, clock, api } = setup();
  api.status = { error: { code: "PGRST202", message: "Could not find the function" } };
  c.start();
  await clock.advance(0);
  assert.equal(c.state.phase, "unavailable");
  assert.deepEqual(clock.pending(), []);
  await clock.advance(120000);
  assert.equal(api.calls.getStatus, 1);
});

test("C10 serviço de conexão fora: 'Preparando conexão' por mais de 45 s vira aviso de demora", async () => {
  const { c, clock, api } = setup();
  api.status = st("connect_requested");
  c.start();
  await clock.advance(0);
  assert.equal(c.state.workerSlow, false);
  await clock.advance(44000);
  assert.equal(c.state.workerSlow, false);
  await clock.advance(2000);
  assert.equal(c.state.workerSlow, true);
  api.status = st("qr_pending");
  await clock.advance(2000);
  assert.equal(c.state.workerSlow, false);
  assert.equal(c.state.waitingSince, null);
});

test("C11 'sem sinal' (stale) vindo do banco é mostrado como tal, sem QR e sem envio", async () => {
  const { c, clock, api } = setup();
  api.status = st("stale", { can_send: false });
  c.start();
  await clock.advance(0);
  assert.equal(c.state.snapshot.status, "stale");
  assert.equal(c.state.snapshot.canSend, false);
  assert.equal(api.calls.getQr, 0);
});

test("C12 erro ao pedir conexão: mensagem clara, nada de 'pedido enviado'", async () => {
  const { c, clock, api } = setup();
  c.start();
  await clock.advance(0);
  api.request = { error: { code: "42501", message: "permission" } };
  await c.connect();
  assert.equal(c.state.notice, null);
  assert.match(c.state.actionError, /Só a administração/);
  api.request = { error: { message: "Failed to fetch" } };
  await c.connect();
  assert.match(c.state.actionError, /Não foi possível pedir a conexão/);
});

test("C13 cliques repetidos não disparam pedidos duplicados", async () => {
  const { c, clock, api } = setup();
  c.start();
  await clock.advance(0);
  await Promise.all([c.connect(), c.connect(), c.connect()]);
  assert.equal(api.calls.requestConnection, 1);
});

test("C14 desconectar: 'pedido enviado' e a tela segue o banco até 'desconectado'", async () => {
  const { c, clock, api } = setup();
  api.status = st("connected");
  c.start();
  await clock.advance(0);
  api.status = st("disconnect_requested");
  await c.disconnect();
  assert.match(c.state.notice, /desconexão enviado/);
  assert.equal(c.state.snapshot.status, "disconnect_requested");
  api.status = st("disconnected");
  await clock.advance(2000);
  assert.equal(c.state.snapshot.status, "disconnected");
  assert.equal(c.state.notice, null);
});

test("C15 aba escondida: para de consultar; ao voltar, consulta na hora", async () => {
  const { c, clock, api } = setup();
  api.status = st("connected");
  c.start();
  await clock.advance(0);
  c.setVisible(false);
  const before = api.calls.getStatus;
  await clock.advance(120000);
  assert.equal(api.calls.getStatus, before);
  c.setVisible(true);
  await clock.advance(0);
  assert.equal(api.calls.getStatus, before + 1);
});

test("C16 sair da tela (stop): nenhuma consulta nem atualização depois", async () => {
  const { c, clock, api, states } = setup();
  c.start();
  await clock.advance(0);
  c.stop();
  const n = states.length;
  await clock.advance(60000);
  assert.equal(states.length, n);
  assert.equal(api.calls.getStatus, 1);
});

test("C17 sessão expirada: avisa e para de consultar", async () => {
  const { c, clock, api } = setup();
  api.status = { error: { code: "28000", message: "Não autenticado." } };
  c.start();
  await clock.advance(0);
  assert.equal(c.state.phase, "session");
  assert.deepEqual(clock.pending(), []);
});

test("C18 falha na rede durante o QR: o QR sai da tela (não dá para garantir que vale)", async () => {
  const { c, clock, api } = setup();
  api.status = st("qr_pending");
  api.qr = () => ({ data: { qr: "2@QR-REDE-xxxxxxx", expires_at: new Date(clock.now() + 60000).toISOString() } });
  c.start();
  await clock.advance(0);
  assert.ok(c.state.qr);
  api.status = { error: { message: "Failed to fetch" } };
  await clock.advance(2000);
  assert.equal(c.state.qr, null);
  assert.match(c.state.refreshError, /Sem conexão/);
});
