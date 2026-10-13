// Processo REAL do worker (node src/index.js) contra o Postgres local, com o
// provedor falso em modo automático (FAKE_AUTO=1: mostra QR e "escaneia" sozinho
// na primeira vez; depois reconecta direto com a credencial salva).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKER_URL = process.env.WA_IT_WORKER_URL
const ADMIN_URL = process.env.WA_IT_ADMIN_URL
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let admin, user, company
const masterKey = randomBytes(32).toString('base64')
const q1 = async (sql, p = []) => { const r = await admin.query(sql, p); return r.rows[0] ? Object.values(r.rows[0])[0] : undefined }
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50) } return false }

const children = new Set()
function startWorker(extraEnv = {}) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test', WA_PROVIDER: 'fake', FAKE_AUTO: '1',
      DATABASE_URL: WORKER_URL, WA_MASTER_KEY: masterKey, WORKER_ID: 'discloud-aurea-wa-1',
      TICK_MS: '250', DB_SSL: 'off', LOG_LEVEL: 'info', SEND_INTERVAL_MS: '0', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.out = ''
  child.stdout.on('data', (d) => { child.out += d })
  child.stderr.on('data', (d) => { child.out += d })
  child.exited = new Promise((r) => child.on('exit', (code, signal) => { children.delete(child); r({ code, signal }) }))
  children.add(child)
  return child
}

before(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 })
  user = await q1('select id from auth.users order by created_at limit 1')
  company = await q1(`insert into companies (name) values ('ZZ-IT-PROC') returning id`)
  await admin.query(`insert into company_members (company_id, user_id, role) values ($1, $2, 'owner')`, [company, user])
  const c = await admin.connect()
  await c.query('begin'); await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user])
  await c.query('set local role authenticated'); await c.query('select wa_request_connection($1)', [company]); await c.query('commit')
  c.release()
})
after(async () => {
  for (const c of children) c.kill('SIGKILL')   // nenhum processo pode sobrar
  await admin.end()
})

const status = () => q1('select status from whatsapp_private.sessions where company_id = $1', [company])
// conectado POR ESTE processo: status connected, posse dele e conexão registrada depois do início
const connectedSince = async (t) => (await q1(
  `select status = 'connected' and lease_owner = 'discloud-aurea-wa-1' and connected_at >= $2 from whatsapp_private.sessions where company_id = $1`,
  [company, new Date(t)])) === true

test('P1 primeira execução: QR → conectado; credenciais gravadas cifradas', { timeout: 30000 }, async () => {
  const ts = Date.now(); const w = startWorker()
  assert.ok(await until(() => connectedSince(ts)), 'não conectou:\n' + w.out)
  assert.match(w.out, /sem credencial: vai gerar QR/)
  assert.ok((await q1('select count(*)::int from whatsapp_private.auth where company_id = $1', [company])) >= 1)
  w.kill('SIGTERM'); await w.exited
})

test('P2 kill -9 (queda brusca) e reinício: reconecta SEM QR e assume a posse na hora (mesmo WORKER_ID)', { timeout: 30000 }, async () => {
  const t1 = Date.now(); const w1 = startWorker()
  assert.ok(await until(() => connectedSince(t1)), w1.out)
  w1.kill('SIGKILL'); const e1 = await w1.exited
  assert.equal(e1.signal, 'SIGKILL')
  assert.equal(await q1('select lease_owner from whatsapp_private.sessions where company_id = $1', [company]), 'discloud-aurea-wa-1', 'posse fica com o morto até vencer')
  await admin.query(`update whatsapp_private.sessions set status = 'connecting' where company_id = $1`, [company])
  const t0 = Date.now()
  const w2 = startWorker()
  assert.ok(await until(() => connectedSince(t0)), 'não reconectou:\n' + w2.out)
  assert.ok(Date.now() - t0 < 5000, 'demorou: deveria assumir a própria posse sem esperar o prazo')
  assert.doesNotMatch(w2.out, /sem credencial: vai gerar QR/, 'pediu QR de novo')
  w2.kill('SIGTERM'); await w2.exited
})

test('P3 SIGTERM: sai com código 0, libera a posse e mantém o status para reconectar', { timeout: 30000 }, async () => {
  const ts = Date.now(); const w = startWorker()
  assert.ok(await until(() => connectedSince(ts)), w.out)
  const t0 = Date.now()
  w.kill('SIGTERM')
  const e = await w.exited
  assert.equal(e.code, 0, w.out)
  assert.ok(Date.now() - t0 < 10000)
  assert.equal(await q1('select lease_owner from whatsapp_private.sessions where company_id = $1', [company]), null)
  assert.equal(await status(), 'connected')
  assert.match(w.out, /encerrado/)
})

test('P4 configuração inválida: o processo não sobe e explica o motivo', { timeout: 30000 }, async () => {
  const w = startWorker({ WA_MASTER_KEY: 'curta' })
  const e = await w.exited
  assert.equal(e.code, 1)
  assert.match(w.out, /32 bytes/)
  const w2 = startWorker({ NODE_ENV: 'production' })
  const e2 = await w2.exited
  assert.equal(e2.code, 1)
  assert.match(w2.out, /NODE_ENV=test/)
})

test('P5 logs não expõem QR, conteúdo de credencial nem o número completo', { timeout: 30000 }, async () => {
  const ts = Date.now(); const w = startWorker({ LOG_LEVEL: 'debug' })
  assert.ok(await until(() => connectedSince(ts)), w.out)
  w.kill('SIGTERM'); await w.exited
  assert.doesNotMatch(w.out, /FAKE-QR/)
  assert.doesNotMatch(w.out, /5511900000000/)
  assert.doesNotMatch(w.out, /noiseKey|signedIdentityKey/)
})
