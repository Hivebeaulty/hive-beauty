// Integração W5: confirmação AUTOMÁTICA ponta a ponta, com o worker REAL
// (gerente, sessão, credenciais cifradas, papel wa_worker) e Postgres LOCAL com
// 0001–0018. O agendamento é criado como a usuária logada (RLS real); o gatilho
// da 0018 enfileira; o worker envia pelo provedor FALSO (sem número nem rede).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import * as fake from '../../src/provider/fake.js'
import { WorkerDb } from '../../src/db.js'
import { useDbAuthState } from '../../src/auth-state.js'
import { SessionManager, makeSessionFactory } from '../../src/manager.js'
import { messageIdFor } from '../../src/wa-utils.js'

const { FakeHub } = fake
const WORKER_URL = process.env.WA_IT_WORKER_URL
const ADMIN_URL = process.env.WA_IT_ADMIN_URL
if (!WORKER_URL || !ADMIN_URL) throw new Error('rode por test/integration/run-local.sh')

const silent = { child() { return silent }, info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const masterKey = randomBytes(32)
let admin, user, A, B, memA, memB, svcA, svcB, cliA, cliA2, cliB
const pools = []
let slot = 0

function newWorker(workerId, cfgOver = {}) {
  const pool = new pg.Pool({ connectionString: WORKER_URL, max: 4 })
  pool.on('error', () => {})
  pools.push(pool)
  const db = new WorkerDb(pool, workerId)
  const config = {
    leaseTtlSec: 60, tickMs: 50, sendIntervalMs: 0, outboxBatch: 10, outboxLockSec: 60, maxSessions: 20,
    maxQrCycles: 5, reconnectBaseMs: 5, reconnectMaxMs: 20, messagingEnabled: true, ...cfgOver,
  }
  const authFactory = (cid) => useDbAuthState({ db, companyId: cid, masterKey, baileys: fake.baileysUtils })
  const manager = new SessionManager({ db, config, logger: silent, createSession: makeSessionFactory({ db, provider: fake, authFactory, logger: silent, config }) })
  return { pool, db, manager }
}

async function asUser(sql, params = []) {
  const c = await admin.connect()
  try {
    await c.query('begin')
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user])
    await c.query('set local role authenticated')
    const r = await c.query(sql, params)
    await c.query('commit')
    return r.rows[0] ? Object.values(r.rows[0])[0] : undefined
  } catch (e) { await c.query('rollback'); throw e } finally { c.release() }
}
const q1 = async (sql, p = []) => { const r = await admin.query(sql, p); return r.rows[0] ? Object.values(r.rows[0])[0] : undefined }
const session = (cid) => admin.query('select * from whatsapp_private.sessions where company_id = $1', [cid]).then((r) => r.rows[0])
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25) } return false }
const outboxOf = (appt) => admin.query('select * from whatsapp_private.outbox where appointment_id = $1', [appt]).then((r) => r.rows)
const state = (appt) => asUser('select wa_get_appointment_confirmation($1)', [appt]).then((j) => j.state)

// agendamento NOVO pela usuária (como a tela faz: insert direto, RLS real)
function schedule({ company = A, client = cliA, service = svcA, member = memA, days } = {}) {
  slot += 1
  const d = days ?? slot
  return asUser(`insert into appointments (company_id, client_id, service_id, professional_member_id, scheduled_start, scheduled_end, price)
                 values ($1, $2, $3, $4, date_trunc('minute', now()) + $5 * interval '1 day', date_trunc('minute', now()) + $5 * interval '1 day' + interval '1 hour', 80)
                 returning id`, [company, client, service, member, d])
}

async function connectFresh(w, cid, phone) {
  const n = FakeHub.sockets.length
  await asUser('select wa_request_connection($1)', [cid])
  await w.manager.tick()
  assert.ok(await until(() => FakeHub.sockets.length > n))
  const sock = FakeHub.sockets[n]
  sock.emitQr('QR-AC-' + cid.slice(0, 8))
  assert.ok(await until(async () => (await session(cid))?.status === 'qr_pending'))
  sock.scanAndOpen(phone)
  assert.ok(await until(async () => (await session(cid))?.status === 'connected'))
  return sock
}

before(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 })
  user = await q1('select id from auth.users order by created_at limit 1')
  await admin.query(`update profiles set full_name = 'Patrícia Souza' where id = $1`, [user])
  A = await q1(`insert into companies (name) values ('ZZ-AC-A') returning id`)
  B = await q1(`insert into companies (name) values ('ZZ-AC-B') returning id`)
  memA = await q1(`insert into company_members (company_id, user_id, role) values ($1, $2, 'owner') returning id`, [A, user])
  memB = await q1(`insert into company_members (company_id, user_id, role) values ($1, $2, 'owner') returning id`, [B, user])
  svcA = await q1(`insert into services (company_id, name, duration_minutes, price) values ($1, 'Manicure', 60, 80) returning id`, [A])
  svcB = await q1(`insert into services (company_id, name, duration_minutes, price) values ($1, 'Pedicure', 60, 80) returning id`, [B])
  cliA = await q1(`insert into clients (company_id, name, phone) values ($1, 'Ana Lima', '11987654321') returning id`, [A])
  cliA2 = await q1(`insert into clients (company_id, name, phone) values ($1, 'Bia Rocha', '11987650077') returning id`, [A])
  cliB = await q1(`insert into clients (company_id, name, phone) values ($1, 'Ana na B', '11987654321') returning id`, [B])
  await admin.query('update whatsapp_private.settings set auto_confirmation_enabled = true')
})
after(async () => {
  await admin.query('update whatsapp_private.settings set auto_confirmation_enabled = false')
  for (const p of pools) await p.end().catch(() => {})
  await admin.end()
})
beforeEach(async () => {
  FakeHub.reset()
  await admin.query('delete from whatsapp_private.appointment_confirmations')
  await admin.query('delete from whatsapp_private.outbox')
  await admin.query('delete from whatsapp_private.messages')
  await admin.query('delete from whatsapp_private.sessions')
  await admin.query(`update clients set comm_status = 'unknown', comm_status_source = null where id = any($1)`, [[cliA, cliA2, cliB]])
    .catch(() => admin.query(`update clients set comm_status = 'unknown' where id = any($1)`, [[cliA, cliA2, cliB]]))
})

test('AC1 agendou → UMA confirmação enviada pelo worker, com id determinístico; tela vê "sent"', async () => {
  const w = newWorker('ac-w1')
  const sock = await connectFresh(w, A, '5511900000001')
  const appt = await schedule()
  await w.manager.tick()
  assert.equal(sock.sent.length, 1)
  const [o] = await outboxOf(appt)
  assert.equal(o.status, 'sent')
  assert.equal(sock.sent[0].jid, '5511987654321@s.whatsapp.net')
  assert.equal(sock.sent[0].id, messageIdFor(o.id))
  assert.match(sock.sent[0].content.text, /^Oi, Ana/)
  assert.match(sock.sent[0].content.text, /Manicure · 1h/)
  assert.match(sock.sent[0].content.text, /Patrícia · ZZ-AC-A$/)
  assert.equal(await state(appt), 'sent')
  for (let i = 0; i < 3; i++) await w.manager.tick()
  assert.equal(sock.sent.length, 1, 'voltas seguintes não reenviam')
  await w.manager.shutdown()
})

test('AC2 editar o agendamento (obs, preço, horário) depois do envio NÃO manda outra confirmação', async () => {
  const w = newWorker('ac-w1')
  const sock = await connectFresh(w, A, '5511900000001')
  const appt = await schedule()
  await w.manager.tick()
  await asUser(`update appointments set notes = 'x', price = 99, scheduled_start = scheduled_start + interval '3 hours',
                scheduled_end = scheduled_end + interval '3 hours' where id = $1`, [appt])
  for (let i = 0; i < 3; i++) await w.manager.tick()
  assert.equal(sock.sent.length, 1)
  assert.equal((await outboxOf(appt)).length, 1)
  await w.manager.shutdown()
})

test('AC3 queda do worker DEPOIS de enviar e ANTES de registrar: o retry reusa o mesmo id; 1 mensagem no banco', async () => {
  const w = newWorker('ac-w1', { outboxLockSec: 10 })
  const sock = await connectFresh(w, A, '5511900000001')
  const appt = await schedule()
  FakeHub.crashAfterSend = 1
  await w.manager.tick()
  const [o1] = await outboxOf(appt)
  assert.equal(o1.status, 'pending', 'falha conta como temporária')
  await admin.query('update whatsapp_private.outbox set available_at = now() where id = $1', [o1.id])
  await w.manager.tick()
  const [o2] = await outboxOf(appt)
  assert.equal(o2.status, 'sent')
  assert.equal(sock.sent.length, 2, 'o provedor viu duas tentativas…')
  assert.equal(sock.sent[0].id, sock.sent[1].id, '…com o MESMO id de mensagem (o WhatsApp trata como a mesma)')
  assert.equal(await q1('select count(*)::int from whatsapp_private.messages where outbox_id = $1', [o2.id]), 1)
  await w.manager.shutdown()
})

test('AC4 worker fora do ar: a confirmação fica pendente; quando volta, envia uma vez', async () => {
  const w1 = newWorker('ac-w1')
  await connectFresh(w1, A, '5511900000001')
  await w1.manager.shutdown()                       // worker parou (sessão continua "connected", sinal recente)
  const appt = await schedule()
  assert.equal((await outboxOf(appt))[0].status, 'pending')
  await sleep(150)
  assert.equal((await outboxOf(appt))[0].status, 'pending', 'ninguém envia enquanto o worker está fora')
  FakeHub.reset()
  const w2 = newWorker('ac-w2')
  await w2.manager.tick()                           // assume a sessão e reabre com as credenciais do banco
  assert.ok(await until(() => FakeHub.sockets.length === 1))
  FakeHub.last().open()
  assert.ok(await until(async () => (await session(A)).status === 'connected' && (await session(A)).lease_owner === 'ac-w2'))
  await w2.manager.tick()
  assert.equal(FakeHub.last().sent.length, 1)
  assert.equal((await outboxOf(appt))[0].status, 'sent')
  await w2.manager.shutdown()
})

test('AC5 sessão caiu (reconectando): não envia nem gasta tentativa; reconectou → envia pelo socket novo', async () => {
  const w = newWorker('ac-w1')
  const sock = await connectFresh(w, A, '5511900000001')
  const appt = await schedule()                       // enfileirada com a sessão boa
  sock.close(428)                                     // cai antes do worker pegar a fila
  assert.ok(await until(() => FakeHub.sockets.length === 2))
  assert.ok(await until(async () => (await session(A)).status === 'connecting'))
  for (let i = 0; i < 3; i++) await w.manager.tick()
  const [o] = await outboxOf(appt)
  assert.equal(o.status, 'pending'); assert.equal(o.attempts, 0)
  assert.equal(sock.sent.length + FakeHub.last().sent.length, 0)
  FakeHub.last().open()
  assert.ok(await until(async () => (await session(A)).status === 'connected'))
  await w.manager.tick()
  assert.equal(FakeHub.last().sent.length, 1)
  assert.equal((await outboxOf(appt))[0].status, 'sent')
  await w.manager.shutdown()
})

test('AC6 falha temporária do banco numa volta: nada é perdido nem duplicado', async () => {
  const w = newWorker('ac-w1')
  const sock = await connectFresh(w, A, '5511900000001')
  const appt = await schedule()
  const real = w.db.claimOutbox.bind(w.db)
  w.db.claimOutbox = async () => { throw Object.assign(new Error('banco fora'), { code: '57P01' }) }
  await w.manager.tick()
  assert.equal(w.manager.consecutiveDbErrors, 1)
  w.db.claimOutbox = real
  await w.manager.tick()
  await w.manager.tick()
  assert.equal(sock.sent.length, 1)
  assert.equal((await outboxOf(appt))[0].status, 'sent')
  await w.manager.shutdown()
})

test('AC7 cliente responde SAIR antes do envio: confirmação cancelada; próximos agendamentos nem enfileiram', async () => {
  const w = newWorker('ac-w1', { messagingEnabled: true })
  const sock = await connectFresh(w, A, '5511900000001')
  await w.manager.shutdown()
  const appt = await schedule()                       // fica na fila (worker parado)
  FakeHub.reset()
  const w2 = newWorker('ac-w2')
  await w2.manager.tick()
  assert.ok(await until(() => FakeHub.sockets.length === 1))
  // chega o SAIR junto com a reconexão, antes da volta que pegaria a fila
  FakeHub.last().open()
  assert.ok(await until(async () => (await session(A)).status === 'connected'))
  FakeHub.last().incoming({ id: 'AC7-IN', from: '5511987654321@s.whatsapp.net', text: 'SAIR' })
  assert.ok(await until(async () => (await q1('select comm_status from clients where id = $1', [cliA])) === 'blocked'))
  await w2.manager.tick()
  assert.equal(FakeHub.last().sent.length, 0)
  assert.equal((await outboxOf(appt))[0].status, 'canceled')
  const next = await schedule()
  assert.equal((await outboxOf(next)).length, 0)
  assert.equal(await state(next), 'skipped')
  assert.equal(sock.sent.length, 0)
  await w2.manager.shutdown()
})

test('AC8 SAIR vindo de contato só com LID: o worker resolve o número e o bloqueio vale', async () => {
  const w = newWorker('ac-w1')
  const sock = await connectFresh(w, A, '5511900000001')
  FakeHub.lidMap.set('77700011@lid', '5511987650077:2@s.whatsapp.net')
  sock.incoming({ id: 'AC8-IN', from: '77700011@lid', text: 'stop' })
  assert.ok(await until(async () => (await q1('select comm_status from clients where id = $1', [cliA2])) === 'blocked'))
  const appt = await schedule({ client: cliA2 })
  await w.manager.tick()
  assert.equal(sock.sent.length, 0)
  assert.equal(await state(appt), 'skipped')
  await w.manager.shutdown()
})

test('AC9 duas empresas no mesmo worker: cada confirmação sai pelo número da própria empresa', async () => {
  const w = newWorker('ac-w1')
  const sA = await connectFresh(w, A, '5511900000001')
  const sB = await connectFresh(w, B, '5511900000002')
  const a1 = await schedule()
  const b1 = await schedule({ company: B, client: cliB, service: svcB, member: memB })
  await w.manager.tick()
  assert.equal(sA.sent.length, 1); assert.equal(sB.sent.length, 1)
  assert.match(sA.sent[0].content.text, /ZZ-AC-A$/)
  assert.match(sB.sent[0].content.text, /ZZ-AC-B$/)
  assert.equal((await outboxOf(a1))[0].status, 'sent'); assert.equal((await outboxOf(b1))[0].status, 'sent')
  await w.manager.shutdown()
})

test('AC10 envio DESLIGADO no worker (padrão atual): a confirmação fica na fila intacta, nada sai', async () => {
  const w = newWorker('ac-w1', { messagingEnabled: false })
  const sock = await connectFresh(w, A, '5511900000001')
  const appt = await schedule()
  for (let i = 0; i < 4; i++) await w.manager.tick()
  assert.equal(sock.sent.length, 0)
  const [o] = await outboxOf(appt)
  assert.equal(o.status, 'pending'); assert.equal(o.attempts, 0)
  await w.manager.shutdown()
})

test('AC11 número sem WhatsApp: falha definitiva, sem novas tentativas; tela vê "failed / no_whatsapp"', async () => {
  const w = newWorker('ac-w1')
  const sock = await connectFresh(w, A, '5511900000001')
  FakeHub.notOnWhatsApp.add('5511987654321')
  const appt = await schedule()
  await w.manager.tick(); await w.manager.tick()
  assert.equal(sock.sent.length, 0)
  const j = await asUser('select wa_get_appointment_confirmation($1)', [appt])
  assert.equal(j.state, 'failed'); assert.equal(j.reason, 'no_whatsapp')
  await w.manager.shutdown()
})
