// Correção das "sincronizações" repetidas no celular (auditoria de 01/11).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { Browsers } from 'baileys'
import * as fake from '../../src/provider/fake.js'
import { socketOptions, NO_PHONE_RESEND } from '../../src/provider/baileys.js'
import { CompanySession } from '../../src/session.js'
import { useDbAuthState } from '../../src/auth-state.js'
import { createLogger, sanitizeConsoleArgs, guardConsole } from '../../src/logger.js'
import { MemoryDb, silentLogger, baseConfig, tick } from './helpers.js'

const { FakeHub } = fake
const A = '22222222-2222-2222-2222-222222222222'
let db, masterKey, factoryCalls
const config = { ...baseConfig, reconnectBaseMs: 5, reconnectMaxMs: 20 }
const make = () => new CompanySession({
  companyId: A, db, provider: fake, logger: silentLogger, config,
  authFactory: (id) => { factoryCalls++; return useDbAuthState({ db, companyId: id, masterKey, baileys: fake.baileysUtils }) },
})
beforeEach(() => { db = new MemoryDb(); masterKey = randomBytes(32); factoryCalls = 0; FakeHub.reset() })

// ---- Baileys: nada de pedido ao celular; grupos fora -----------------------------------
const fakeAuth = { state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } } }

test('Baileys nunca pede ao celular cópia de mensagem (cache sempre responde "já pedido")', async () => {
  const o = socketOptions({ auth: fakeAuth, logger: silentLogger })
  assert.equal(o.placeholderResendCache, NO_PHONE_RESEND)
  assert.equal(await o.placeholderResendCache.get('QUALQUER-ID'), true)
})

test('grupos, transmissões, status e canais são ignorados antes de decifrar; conversas individuais não', () => {
  const o = socketOptions({ auth: fakeAuth, logger: silentLogger })
  for (const j of ['120363430174347833@g.us', 'status@broadcast', '123@broadcast', '456@newsletter']) assert.equal(o.shouldIgnoreJid(j), true, j)
  for (const j of ['5511987654321@s.whatsapp.net', '256143276384440@lid', 's.whatsapp.net']) assert.equal(o.shouldIgnoreJid(j), false, j)
  assert.equal(socketOptions({ auth: fakeAuth, logger: silentLogger, ignoreGroups: false }).shouldIgnoreJid('1@g.us'), false)
})

test('o aparelho conectado continua com a mesma identificação (não muda o pareamento)', () => {
  const o = socketOptions({ auth: fakeAuth, logger: silentLogger })
  assert.deepEqual(o.browser, Browsers.ubuntu('Áurea'))
})

// ---- Reconexão: mesmo estado de credenciais, sem reler o banco -------------------------
test('reconexão reaproveita o MESMO estado de credenciais (lê o banco uma vez só)', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  const auth1 = FakeHub.last().auth
  FakeHub.last().close(428); await tick(80)
  assert.equal(FakeHub.sockets.length, 2)
  assert.equal(FakeHub.last().auth, auth1)
  assert.equal(factoryCalls, 1)
})

test('reconexão espera as gravações pendentes do socket anterior antes de abrir o novo', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  // gravação lenta em andamento quando a conexão cai
  const slow = new Promise((r) => setTimeout(r, 60))
  const orig = db.authWrite.bind(db)
  let done = false
  db.authWrite = async (...a) => { await slow; done = true; return orig(...a) }
  FakeHub.last().auth.state.keys.set({ session: { 'x.0': { a: 1 } } })
  FakeHub.last().close(428)
  await tick(30)
  assert.equal(FakeHub.sockets.length, 1, 'não abre o socket novo com gravação pendente')
  await tick(120)
  assert.equal(done, true)
  assert.equal(FakeHub.sockets.length, 2)
})

// ---- Logs: sem chaves da libsignal nem identificadores ---------------------------------
test('console: linhas de sessão da libsignal são descartadas e objetos com chaves viram [omitido]', () => {
  const session = { _chains: {}, currentRatchet: { rootKey: Buffer.alloc(32), ephemeralKeyPair: { privKey: Buffer.alloc(32) } } }
  assert.equal(sanitizeConsoleArgs(['Closing session:', session]), null)
  assert.equal(sanitizeConsoleArgs(['Opening session:', session]), null)
  assert.equal(sanitizeConsoleArgs(['Closing open session in favor of incoming prekey bundle']), null)
  assert.deepEqual(sanitizeConsoleArgs(['Session error:', session]), ['Session error:', '[omitido]'])
  assert.deepEqual(sanitizeConsoleArgs(['texto comum', { a: 1 }]), ['texto comum', { a: 1 }])
})

test('guardConsole: o console protegido não imprime a sessão', () => {
  const out = []
  const target = { log: (...a) => out.push(a), info: (...a) => out.push(a), warn: (...a) => out.push(a), error: (...a) => out.push(a), debug: (...a) => out.push(a) }
  guardConsole(target)
  target.info('Closing session:', { _chains: {} })
  target.warn('aviso', { privKey: Buffer.alloc(4) })
  assert.deepEqual(out, [['aviso', '[omitido]']])
})

test('log estruturado: identificadores de contato nos erros do Baileys ficam ocultos', async () => {
  const lines = []
  const dest = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb() } })
  const log = createLogger('info', dest)
  log.error({ key: { remoteJid: '120363@g.us', participant: '256@lid', participantAlt: '5513991075867@s.whatsapp.net', id: 'AC9' }, sender: '120363@g.us', author: '256@lid' }, 'failed to decrypt message')
  await tick(10)
  const txt = lines.join('')
  assert.doesNotMatch(txt, /5513991075867|256@lid|120363@g\.us/)
  assert.match(txt, /AC9/)
})
