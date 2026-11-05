// Quedas de conexão (auditoria de 04/11): só o 401 (aparelho removido) apaga as credenciais.
// 500 e 411 reconectam com as credenciais intactas; se não voltarem, param em "erro" SEM apagar nada.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import * as fake from '../../src/provider/fake.js'
import { CompanySession } from '../../src/session.js'
import { useDbAuthState } from '../../src/auth-state.js'
import { MemoryDb, silentLogger, baseConfig, tick } from './helpers.js'

const { FakeHub } = fake
const A = '33333333-3333-3333-3333-333333333333'
const CREDS = `${A}|creds|creds`
let db, masterKey, stopped
const config = { ...baseConfig, reconnectBaseMs: 5, reconnectMaxMs: 20, badSessionMaxRetries: 3 }
const make = (cfg = config) => new CompanySession({
  companyId: A, db, provider: fake, logger: silentLogger, config: cfg,
  authFactory: (id) => useDbAuthState({ db, companyId: id, masterKey, baileys: fake.baileysUtils }),
  onStopped: (id, reason) => { stopped = reason },
})
beforeEach(() => { db = new MemoryDb(); masterKey = randomBytes(32); stopped = null; FakeHub.reset() })

for (const code of [500, 411]) {
  test(`erro ${code}: NÃO apaga as credenciais, reconecta com o mesmo estado e volta a conectar`, async () => {
    const s = make(); await s.start()
    FakeHub.last().scanAndOpen(); await tick(20)
    assert.ok(db.auth.has(CREDS))
    FakeHub.last().close(code); await tick(80)
    assert.equal(FakeHub.sockets.length, 2, 'abriu um socket novo')
    assert.ok(!db.states().includes('logged_out'), 'não pode virar logged_out')
    assert.ok(!db.states().includes('error'))
    assert.ok(db.auth.has(CREDS), 'credenciais preservadas')
    FakeHub.last().open(); await tick(20)
    assert.equal(s.state, 'open')
    assert.equal(s.badSessionCount, 0, 'conectou: zera a contagem')
    assert.equal(stopped, null)
  })
}

test('500 que não passa: depois do limite para em "erro" com o motivo, SEM apagar as credenciais', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  for (let i = 0; i < 4; i++) { FakeHub.last().close(500); await tick(70) }   // limite = 3 tentativas; a 4ª queda para
  await tick(120)                                                              // a parada espera a biblioteca silenciar
  assert.equal(stopped, 'bad_session')
  assert.equal(FakeHub.sockets.length, 4, '1 inicial + 3 tentativas')
  const err = db.calls.find((c) => c.setState === 'error')
  assert.ok(err, 'estado error gravado')
  assert.match(err.error, /500/)
  assert.match(err.error, /Conectar/)
  assert.ok(!db.states().includes('logged_out'))
  assert.ok(db.auth.has(CREDS), 'credenciais continuam no banco: Conectar reabre sem QR')
})

test('conectar no meio zera a contagem: quedas espaçadas nunca chegam ao limite', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  for (let i = 0; i < 6; i++) { FakeHub.last().close(500); await tick(70); FakeHub.last().open(); await tick(20) }
  assert.equal(s.state, 'open')
  assert.equal(stopped, null)
  assert.ok(!db.states().includes('error'))
})

test('401 (aparelho removido) continua pedindo novo QR, agora com o motivo registrado', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  FakeHub.last().close(401); await tick(120)
  assert.equal(stopped, 'logged_out')
  const lo = db.calls.find((c) => c.setState === 'logged_out')
  assert.ok(lo)
  assert.match(lo.error, /desconectou.*401/)
  assert.equal(FakeHub.sockets.length, 1, 'não tenta de novo')
})

test('aberturas e quedas ficam registradas com o código e o tipo', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  FakeHub.last().close(500); await tick(70)
  FakeHub.last().close(428); await tick(70)
  const ev = db.calls.filter((c) => c.event).map((c) => c.event.slice(0, 3))
  assert.deepEqual(ev, [['open', null, null], ['close', 500, 'bad_session'], ['close', 428, 'reconnect']])
})

test('falha ao registrar o evento no banco não derruba a conexão', async () => {
  db.recordConnectionEvent = async () => { throw new Error('banco sem a função (migration 0050 pendente)') }
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  assert.equal(s.state, 'open')
  FakeHub.last().close(428); await tick(80)
  assert.equal(FakeHub.sockets.length, 2)
})

test('worker sem a função de evento (banco antigo/teste): segue normalmente', async () => {
  db.recordConnectionEvent = undefined
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  assert.equal(s.state, 'open')
  FakeHub.last().close(428); await tick(80)
  assert.equal(FakeHub.sockets.length, 2)
})
