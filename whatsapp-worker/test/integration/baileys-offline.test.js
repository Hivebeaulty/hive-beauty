// Baileys REAL (não o falso) com o banco local real. Neste ambiente a rede do
// WhatsApp é inacessível (DNS de web.whatsapp.com falha), então o teste verifica,
// com a biblioteca verdadeira, o caminho de rede indisponível: fecha com 408,
// o worker reconecta com espera crescente, não derruba o processo, não grava QR
// e encerra limpo. NÃO testa conexão real (precisa de rede e de um número de teste).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import * as real from '../../src/provider/baileys.js'
import { WorkerDb } from '../../src/db.js'
import { useDbAuthState } from '../../src/auth-state.js'
import { SessionManager, makeSessionFactory } from '../../src/manager.js'

const silent = { level: 'silent', child() { return silent }, info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let admin, pool, company

before(async () => {
  admin = new pg.Pool({ connectionString: process.env.WA_IT_ADMIN_URL, max: 2 })
  pool = new pg.Pool({ connectionString: process.env.WA_IT_WORKER_URL, max: 3 })
  const user = (await admin.query('select id from auth.users order by created_at limit 1')).rows[0].id
  company = (await admin.query(`insert into companies (name) values ('ZZ-IT-REAL') returning id`)).rows[0].id
  await admin.query(`insert into company_members (company_id, user_id, role) values ($1, $2, 'owner')`, [company, user])
  await admin.query(`insert into whatsapp_private.sessions (company_id, status) values ($1, 'connect_requested')`, [company])
})
after(async () => { await pool.end(); await admin.end() })

test('R1 Baileys real sem rede do WhatsApp: reconecta com espera crescente, sem QR, sem cair, encerra limpo', { timeout: 30000 }, async () => {
  const db = new WorkerDb(pool, 'it-real')
  const config = { leaseTtlSec: 60, tickMs: 100, sendIntervalMs: 0, outboxBatch: 10, outboxLockSec: 60, maxSessions: 5, maxQrCycles: 5, reconnectBaseMs: 200, reconnectMaxMs: 800 }
  const authFactory = (cid) => useDbAuthState({ db, companyId: cid, masterKey: randomBytes(32), baileys: real.baileysUtils })
  const manager = new SessionManager({ db, config, logger: silent, createSession: makeSessionFactory({ db, provider: real, authFactory, logger: silent, config }) })
  await manager.tick()
  const s = manager.sessions.get(company)?.session
  assert.ok(s, 'sessão iniciada')
  await sleep(3000)
  assert.ok(s.attempt >= 2, `tentativas: ${s.attempt}`)
  assert.equal(s.isActive, true)
  const row = (await admin.query('select status, lease_owner from whatsapp_private.sessions where company_id = $1', [company])).rows[0]
  assert.equal(row.status, 'connecting')
  assert.equal(row.lease_owner, 'it-real')
  assert.equal((await admin.query('select count(*)::int n from whatsapp_private.qr where company_id = $1', [company])).rows[0].n, 0)
  await manager.shutdown()
  assert.equal(s.state, 'stopped')
  assert.equal((await admin.query('select lease_owner from whatsapp_private.sessions where company_id = $1', [company])).rows[0].lease_owner, null)
})
