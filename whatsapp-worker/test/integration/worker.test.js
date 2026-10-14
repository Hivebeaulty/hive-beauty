// Integração: worker REAL (gerente, sessão, credenciais cifradas, acesso ao banco
// pelo papel wa_worker) contra um Postgres LOCAL com as migrations 0001–0017.
// Só o WhatsApp é falso (provedor de teste): não há número nem rede do WhatsApp.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import * as fake from '../../src/provider/fake.js'
import { WorkerDb } from '../../src/db.js'
import { useDbAuthState } from '../../src/auth-state.js'
import { SessionManager, makeSessionFactory } from '../../src/manager.js'
import { aadFor, companyKey, decrypt } from '../../src/crypto.js'
import { BufferJSON } from 'baileys'

const { FakeHub } = fake
const WORKER_URL = process.env.WA_IT_WORKER_URL
const ADMIN_URL = process.env.WA_IT_ADMIN_URL
if (!WORKER_URL || !ADMIN_URL) throw new Error('rode por test/integration/run-local.sh')

const silent = { child() { return silent }, info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const masterKey = randomBytes(32)
let admin, user, company, companyB, client, clientB
const pools = []

function newWorker(workerId, cfgOver = {}) {
  const pool = new pg.Pool({ connectionString: WORKER_URL, max: 4 })
  pool.on('error', () => {})
  pools.push(pool)
  const db = new WorkerDb(pool, workerId)
  const config = {
    leaseTtlSec: 60, tickMs: 50, sendIntervalMs: 0, outboxBatch: 10, outboxLockSec: 60, maxSessions: 20,
    maxQrCycles: 5, reconnectBaseMs: 5, reconnectMaxMs: 20, ...cfgOver,
  }
  const authFactory = (cid) => useDbAuthState({ db, companyId: cid, masterKey, baileys: fake.baileysUtils })
  const manager = new SessionManager({ db, config, logger: silent, createSession: makeSessionFactory({ db, provider: fake, authFactory, logger: silent, config }) })
  return { pool, db, manager, config }
}

// chama uma RPC do app como a usuária logada (owner da empresa)
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
const session = (cid = company) => admin.query('select * from whatsapp_private.sessions where company_id = $1', [cid]).then((r) => r.rows[0])
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25) } return false }

before(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 })
  user = await q1('select id from auth.users order by created_at limit 1')
  company = await q1(`insert into companies (name) values ('ZZ-IT-A') returning id`)
  companyB = await q1(`insert into companies (name) values ('ZZ-IT-B') returning id`)
  await admin.query(`insert into company_members (company_id, user_id, role) values ($1, $3, 'owner'), ($2, $3, 'owner')`, [company, companyB, user])
  client = await q1(`insert into clients (company_id, name, phone) values ($1, 'Cliente A', '11987654321') returning id`, [company])
  clientB = await q1(`insert into clients (company_id, name, phone) values ($1, 'Cliente B', '11987650099') returning id`, [companyB])
})
after(async () => {
  for (const p of pools) await p.end().catch(() => {})
  await admin.end()
})
beforeEach(async () => {
  FakeHub.reset()
  // banco descartável: zera o estado do WhatsApp de TODAS as empresas (outros
  // arquivos de teste deixam sessões que um worker real assumiria)
  await admin.query('delete from whatsapp_private.outbox')
  await admin.query('delete from whatsapp_private.messages')
  await admin.query('delete from whatsapp_private.sessions')
  await admin.query(`update clients set comm_status = 'unknown' where id in ($1, $2)`, [client, clientB])
})

async function connectFresh(w, cid = company, phone = '5511900000001') {
  const n = FakeHub.sockets.length
  await asUser('select wa_request_connection($1)', [cid])
  await w.manager.tick()
  assert.ok(await until(() => FakeHub.sockets.length > n))
  const sock = FakeHub.sockets[n]
  sock.emitQr('QR-IT-' + cid.slice(0, 8))
  assert.ok(await until(async () => (await session(cid))?.status === 'qr_pending'))
  sock.scanAndOpen(phone)
  assert.ok(await until(async () => (await session(cid))?.status === 'connected'))
  return sock
}

test('I1 pedido de conexão → posse, QR visível só pelo app, conexão, credenciais CIFRADAS no banco', async () => {
  const w = newWorker('it-w1')
  await asUser('select wa_request_connection($1)', [company])
  await w.manager.tick()
  assert.equal((await session()).lease_owner, 'it-w1')
  assert.equal(await q1(`select status from whatsapp_private.outbox where company_id = $1 and kind = 'connect'`, [company]), 'done')
  const sock = FakeHub.last()
  sock.emitQr('QR-DE-TESTE-I1')
  assert.ok(await until(async () => (await session()).status === 'qr_pending'))
  assert.equal((await asUser('select wa_get_qr($1)', [company])).qr, 'QR-DE-TESTE-I1')
  sock.scanAndOpen('5511912345678')
  assert.ok(await until(async () => (await session()).status === 'connected'))
  const s = await session()
  assert.equal(s.phone, '5511912345678')
  assert.equal(await q1('select count(*)::int from whatsapp_private.qr where company_id = $1', [company]), 0)
  const row = (await admin.query(`select data, key_version from whatsapp_private.auth where company_id = $1 and category = 'creds'`, [company])).rows[0]
  assert.ok(row, 'credenciais gravadas')
  assert.ok(!row.data.includes(Buffer.from('5511912345678')), 'número em claro no banco')
  assert.ok(!row.data.includes(Buffer.from('noiseKey')), 'JSON em claro no banco')
  const creds = JSON.parse(decrypt(companyKey(masterKey, company, 1), row.data, aadFor(company, 'creds', 'creds')).toString(), BufferJSON.reviver)
  assert.equal(creds.me.id, '5511912345678:7@s.whatsapp.net')
  await w.manager.shutdown()
})

test('I2 reinício do worker: reconecta com as credenciais do banco, SEM novo QR', async () => {
  const w1 = newWorker('it-w1')
  await connectFresh(w1)
  await w1.manager.shutdown()
  const s1 = await session()
  assert.equal(s1.lease_owner, null, 'posse liberada no encerramento')
  assert.equal(s1.status, 'connected', 'continua marcada para reconectar')
  assert.ok(!FakeHub.last().loggedOut, 'encerramento não pode fazer logout')
  FakeHub.reset()
  const w2 = newWorker('it-w2')
  await w2.manager.tick()
  assert.ok(await until(() => FakeHub.sockets.length === 1))
  const sock = FakeHub.last()
  assert.equal(sock.auth.hadCreds, true)
  assert.equal(sock.auth.state.creds.registered, true)
  sock.open()
  assert.ok(await until(async () => (await session()).status === 'connected' && (await session()).lease_owner === 'it-w2'))
  assert.equal(await q1('select count(*)::int from whatsapp_private.qr where company_id = $1', [company]), 0)
  await w2.manager.shutdown()
})

test('I3 queda de rede: reconecta sozinho e volta a "connected"', async () => {
  const w = newWorker('it-w1')
  await connectFresh(w)
  FakeHub.last().close(428)
  assert.ok(await until(() => FakeHub.sockets.length === 2))
  assert.equal((await session()).status, 'connecting')
  FakeHub.last().open()
  assert.ok(await until(async () => (await session()).status === 'connected'))
  await w.manager.shutdown()
})

test('I4 banco derruba as conexões do worker: a próxima volta se recupera e a sessão continua', async () => {
  const w = newWorker('it-w1')
  await connectFresh(w)
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'wa_worker'`)
  await sleep(100)
  await w.manager.tick()   // pode falhar nesta volta…
  await w.manager.tick()   // …e se recuperar na seguinte
  assert.equal(w.manager.consecutiveDbErrors, 0)
  assert.equal((await session()).lease_owner, 'it-w1')
  assert.ok(FakeHub.last().ended === false)
  await w.manager.shutdown()
})

test('I5 banco fora por quase todo o prazo da posse: a sessão para por segurança', async () => {
  let t = Date.now()
  const w = newWorker('it-w1', { leaseTtlSec: 60 })
  w.manager.now = () => t
  await connectFresh(w)
  const real = w.db.heartbeat.bind(w.db)
  w.db.heartbeat = async () => { throw new Error('banco fora') }
  t += 30000; await w.manager.tick()
  assert.equal(w.manager.sessions.size, 1, 'ainda dentro do prazo')
  t += 25000; await w.manager.tick()
  assert.equal(w.manager.sessions.size, 0, 'passou de 80% do prazo sem renovar')
  assert.ok(FakeHub.last().ended)
  w.db.heartbeat = real
  await w.manager.shutdown()
})

test('I6 dois workers: só um fica com a sessão; o outro assume depois que a posse vence', async () => {
  const w1 = newWorker('it-w1'); const w2 = newWorker('it-w2')
  await connectFresh(w1)
  await w2.manager.tick()
  assert.equal(w2.manager.sessions.size, 0)
  assert.equal(FakeHub.sockets.length, 1)
  // w1 "morre" sem liberar a posse
  await w1.manager.sessions.get(company).session.stop({ reason: 'crash', release: false })
  w1.manager.sessions.clear()
  await w2.manager.tick()
  assert.equal(w2.manager.sessions.size, 0, 'posse ainda válida')
  await admin.query(`update whatsapp_private.sessions set lease_until = now() - interval '1 second' where company_id = $1`, [company])
  await w2.manager.tick()
  assert.equal(w2.manager.sessions.size, 1)
  assert.equal((await session()).lease_owner, 'it-w2')
  await w2.manager.shutdown()
})

test('I7 posse tomada por outro worker: este para a sessão na próxima volta', async () => {
  const w = newWorker('it-w1')
  await connectFresh(w)
  await admin.query(`update whatsapp_private.sessions set lease_owner = 'intruso', lease_until = now() + interval '1 minute' where company_id = $1`, [company])
  await w.manager.tick()
  assert.equal(w.manager.sessions.size, 0)
  assert.ok(FakeHub.last().ended)
  assert.ok(!FakeHub.last().loggedOut)
})

test('I0 W2 padrão (mensagens desligadas): envio pedido pelo app fica INTACTO na fila; mensagem recebida não é gravada', async () => {
  const w = newWorker('it-w1')
  const sock = await connectFresh(w)
  const r = await asUser('select wa_send_message($1, $2, $3)', [client, 'Olá!', 'it-w2-k'])
  assert.equal(r.created, true)
  for (let i = 0; i < 5; i++) await w.manager.tick()
  assert.equal(sock.sent.length, 0)
  assert.equal(await q1(`select status || '/' || attempts from whatsapp_private.outbox where idempotency_key = 'it-w2-k'`), 'pending/0')
  sock.incoming({ id: 'IT-W2-IN', from: '5511987654321@s.whatsapp.net', text: 'oi' })
  await sleep(100)
  assert.equal(await q1(`select count(*)::int from whatsapp_private.messages where wa_message_id = 'IT-W2-IN'`), 0)
  await w.manager.shutdown()
})

test('I8 (W4/W5, ligado) envio pelo app: enfileira, o worker envia uma vez e grava a mensagem; mesma chave não reenvia', async () => {
  const w = newWorker('it-w1', { messagingEnabled: true })
  const sock = await connectFresh(w)
  const r = await asUser('select wa_send_message($1, $2, $3)', [client, 'Olá, confirmando!', 'it-k1'])
  assert.equal(r.created, true)
  await w.manager.tick()
  assert.equal(sock.sent.length, 1)
  assert.equal(sock.sent[0].jid, '5511987654321@s.whatsapp.net')
  assert.equal(await q1(`select status from whatsapp_private.outbox where idempotency_key = 'it-k1'`), 'sent')
  assert.equal(await q1(`select count(*)::int from whatsapp_private.messages where direction = 'out' and client_id = $1`, [client]), 1)
  await asUser('select wa_send_message($1, $2, $3)', [client, 'Olá, confirmando!', 'it-k1'])
  await w.manager.tick()
  assert.equal(sock.sent.length, 1)
  await w.manager.shutdown()
})

test('I9 (W4/W5, ligado) falha temporária de envio volta para a fila e envia depois; número sem WhatsApp falha de vez', async () => {
  const w = newWorker('it-w1', { messagingEnabled: true })
  const sock = await connectFresh(w)
  FakeHub.sendFailures = 1
  await asUser('select wa_send_message($1, $2, $3)', [client, 'tentativa', 'it-k2'])
  await w.manager.tick()
  assert.equal(await q1(`select status from whatsapp_private.outbox where idempotency_key = 'it-k2'`), 'pending')
  await admin.query(`update whatsapp_private.outbox set available_at = now() where idempotency_key = 'it-k2'`)
  await w.manager.tick()
  assert.equal(await q1(`select status from whatsapp_private.outbox where idempotency_key = 'it-k2'`), 'sent')
  assert.equal(sock.sent.length, 1)
  FakeHub.notOnWhatsApp.add('5511987654321')
  await asUser('select wa_send_message($1, $2, $3)', [client, 'sem whatsapp', 'it-k3'])
  await w.manager.tick()
  assert.equal(await q1(`select status from whatsapp_private.outbox where idempotency_key = 'it-k3'`), 'failed')
  await w.manager.shutdown()
})

test('I10 (W4/W5, ligado) mensagem recebida liga à cliente; "SAIR" bloqueia e o app passa a recusar envio', async () => {
  const w = newWorker('it-w1', { messagingEnabled: true })
  const sock = await connectFresh(w)
  sock.incoming({ id: 'IT-IN-1', from: '5511987654321@s.whatsapp.net', text: 'Oi, tudo bem?' })
  assert.ok(await until(async () => (await q1(`select client_id from whatsapp_private.messages where wa_message_id = 'IT-IN-1'`)) === client))
  sock.incoming({ id: 'IT-IN-2', from: '5511987654321@s.whatsapp.net', text: 'SAIR' })
  assert.ok(await until(async () => (await q1('select comm_status from clients where id = $1', [client])) === 'blocked'))
  assert.equal(await q1('select comm_status_source from clients where id = $1', [client]), 'client_opt_out')
  await assert.rejects(() => asUser('select wa_send_message($1, $2, $3)', [client, 'oi', 'it-k4']), (e) => e.code === 'AUW02')
  await w.manager.shutdown()
})

test('I11 (W4/W5, ligado) confirmação de entrega e leitura chega ao banco', async () => {
  const w = newWorker('it-w1', { messagingEnabled: true })
  const sock = await connectFresh(w)
  await asUser('select wa_send_message($1, $2, $3)', [client, 'oi', 'it-k5'])
  await w.manager.tick()
  const waId = sock.sent[0].id
  sock.receipt(waId, 3)
  assert.ok(await until(async () => (await q1('select status from whatsapp_private.messages where wa_message_id = $1', [waId])) === 'delivered'))
  sock.receipt(waId, 4)
  assert.ok(await until(async () => (await q1('select status from whatsapp_private.messages where wa_message_id = $1', [waId])) === 'read'))
  await w.manager.shutdown()
})

test('I12 desconectar pelo app: logout, credenciais apagadas, posse liberada, não volta sozinho', async () => {
  const w = newWorker('it-w1')
  const sock = await connectFresh(w)
  await asUser('select wa_disconnect($1)', [company])
  await w.manager.tick()
  assert.ok(sock.loggedOut)
  const s = await session()
  assert.equal(s.status, 'disconnected')
  assert.equal(s.lease_owner, null)
  assert.equal(await q1('select count(*)::int from whatsapp_private.auth where company_id = $1', [company]), 0)
  await w.manager.tick()
  assert.equal(FakeHub.sockets.length, 1, 'não reconectou sozinho')
  await w.manager.shutdown()
})

test('I13 desconectado pelo celular (401): logged_out, credenciais apagadas, não volta sozinho', async () => {
  const w = newWorker('it-w1')
  const sock = await connectFresh(w)
  sock.close(401)
  assert.ok(await until(async () => (await session()).status === 'logged_out'))
  assert.equal(await q1('select count(*)::int from whatsapp_private.auth where company_id = $1', [company]), 0)
  await w.manager.tick(); await w.manager.tick()
  assert.equal(FakeHub.sockets.length, 1)
  await w.manager.shutdown()
})

test('I14 (W4/W5, ligado) duas empresas no mesmo worker: sessões, credenciais e envios isolados', async () => {
  const w = newWorker('it-w1', { messagingEnabled: true })
  const sockA = await connectFresh(w, company, '5511900000001')
  const sockB = await connectFresh(w, companyB, '5511900000002')
  assert.notEqual(sockA, sockB)
  await asUser('select wa_send_message($1, $2, $3)', [clientB, 'para a B', 'it-kb'])
  await w.manager.tick()
  assert.equal(sockA.sent.length, 0)
  assert.equal(sockB.sent.length, 1)
  const rowA = (await admin.query(`select data from whatsapp_private.auth where company_id = $1 and category = 'creds'`, [company])).rows[0]
  assert.throws(() => decrypt(companyKey(masterKey, companyB, 1), rowA.data, aadFor(companyB, 'creds', 'creds')))
  await w.manager.shutdown()
})

test('I15 encerramento limpo com várias sessões: tudo fechado sem logout, posses liberadas', async () => {
  const w = newWorker('it-w1')
  await connectFresh(w, company, '5511900000001')
  await connectFresh(w, companyB, '5511900000002')
  await w.manager.shutdown()
  assert.ok(FakeHub.sockets.every((s) => s.ended && !s.loggedOut))
  assert.equal(await q1(`select count(*)::int from whatsapp_private.sessions where company_id in ($1, $2) and lease_owner is not null`, [company, companyB]), 0)
  assert.equal(await q1(`select count(*)::int from whatsapp_private.sessions where company_id in ($1, $2) and status = 'connected'`, [company, companyB]), 2)
})

test('I16 o papel do worker não lê tabelas nem chama RPCs do app (permissões mínimas de verdade)', async () => {
  const w = newWorker('it-w1')
  await assert.rejects(() => w.pool.query('select * from clients limit 1'), (e) => e.code === '42501')
  await assert.rejects(() => w.pool.query('select * from whatsapp_private.auth limit 1'), (e) => e.code === '42501')
  await assert.rejects(() => w.pool.query(`select wa_send_message('${client}', 'x', 'y')`), (e) => e.code === '42501')
  await assert.rejects(() => w.pool.query('select aurea_private.run_auto_conclusion()'), (e) => e.code === '42501')
})
