import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import * as fake from '../../src/provider/fake.js'
import { CompanySession, NonRetryableError } from '../../src/session.js'
import { useDbAuthState } from '../../src/auth-state.js'
import { messageIdFor } from '../../src/wa-utils.js'
import { MemoryDb, silentLogger, baseConfig, tick } from './helpers.js'

const { FakeHub } = fake
const A = '11111111-1111-1111-1111-111111111111'
let db, masterKey, stopped
const config = { ...baseConfig, reconnectBaseMs: 5, reconnectMaxMs: 20 }
const make = (cfg = config) => new CompanySession({
  companyId: A, db, provider: fake, logger: silentLogger, config: cfg,
  authFactory: (id) => useDbAuthState({ db, companyId: id, masterKey, baileys: fake.baileysUtils }),
  onStopped: (id, reason) => { stopped = reason },
})
beforeEach(() => { db = new MemoryDb(); masterKey = randomBytes(32); stopped = null; FakeHub.reset() })

test('sem credencial: grava QR; ao escanear, conecta e grava número e credenciais cifradas', async () => {
  const s = make(); await s.start()
  FakeHub.last().emitQr('QR-1'); await tick()
  assert.ok(db.calls.some((c) => c.putQr === 'QR-1'))
  FakeHub.last().scanAndOpen('5511912345678'); await tick(20)
  assert.equal(s.state, 'open')
  const conn = db.calls.find((c) => c.setState === 'connected')
  assert.equal(conn.phone, '5511912345678')
  assert.ok(db.auth.has(`${A}|creds|creds`))
})

test('QR não escaneado depois do limite: marca desconectado com motivo e encerra', async () => {
  const s = make(); await s.start()
  for (let i = 0; i < 4; i++) { FakeHub.last().emitQr(`QR-${i}`); await tick() }
  assert.equal(stopped, 'qr_timeout')
  assert.ok(db.calls.some((c) => c.setState === 'disconnected' && /QR/.test(c.error)))
})

test('queda de rede (428): reconecta sozinho com novo socket e volta a conectar', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  FakeHub.last().close(428); await tick(60)
  assert.equal(FakeHub.sockets.length, 2)
  assert.ok(FakeHub.sockets[0].ended)
  FakeHub.last().open(); await tick(20)
  assert.equal(s.state, 'open')
  assert.equal(s.attempt, 0)
})

test('reinício pedido pelo WhatsApp (515): reconecta na hora', async () => {
  const s = make({ ...config, reconnectBaseMs: 10000 }); await s.start()
  FakeHub.last().close(515); await tick(30)
  assert.equal(FakeHub.sockets.length, 2)
})

test('várias quedas seguidas: espera cresce e não dispara reconexões duplicadas', async () => {
  const s = make({ ...config, reconnectBaseMs: 5, reconnectMaxMs: 40 }); await s.start()
  for (let i = 0; i < 4; i++) { FakeHub.last().close(408); await tick(80) }
  assert.equal(FakeHub.sockets.length, 5)
  assert.equal(s.attempt, 4)
})

test('evento do socket ANTIGO após reconectar é ignorado (sem reconexão fantasma)', async () => {
  const s = make(); await s.start()
  const old = FakeHub.last(); old.close(428); await tick(60)
  const n = FakeHub.sockets.length
  old.ended = false; old.close(428); await tick(60)
  assert.equal(FakeHub.sockets.length, n)
})

test('desconectado pelo celular (401): estado logged_out e encerra sem tentar de novo', async () => {
  const s = make(); await s.start()
  FakeHub.last().scanAndOpen(); await tick(20)
  FakeHub.last().close(401); await tick(60)
  assert.equal(stopped, 'logged_out')
  assert.ok(db.states().includes('logged_out'))
  assert.equal(FakeHub.sockets.length, 1)
})

test('sessão aberta em outro lugar (440) e acesso negado (403): erro e encerra', async () => {
  for (const [code, reason] of [[440, 'replaced'], [403, 'forbidden']]) {
    db = new MemoryDb(); FakeHub.reset()
    const s = make(); await s.start()
    FakeHub.last().close(code); await tick(30)
    assert.equal(stopped, reason)
    assert.ok(db.calls.some((c) => c.setState === 'error'))
  }
})

// W2: mensagens DESLIGADAS por padrão. Os dois testes abaixo exercitam o código
// da W4 explicitamente ligado; o teste seguinte prova o padrão desligado.
const withMessaging = { ...config, messagingEnabled: true }

test('W2 padrão: mensagens DESLIGADAS — nada recebido é gravado e recibos são ignorados', async () => {
  const s = make(); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  const sock = FakeHub.last()
  assert.equal(sock.ev.listenerCount('messages.upsert'), 0)
  assert.equal(sock.ev.listenerCount('messages.update'), 0)
  sock.incoming({ id: 'M1', from: '5511987654321@s.whatsapp.net', text: 'oi' })
  sock.receipt('OUT-1', 3)
  await tick(20)
  assert.equal(db.calls.filter((c) => c.inbound || c.status).length, 0)
})

test('(W4, ligado) mensagem recebida: grava com o número (prefere o alternativo ao LID); ignora grupo e as próprias', async () => {
  const s = make(withMessaging); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  const sock = FakeHub.last()
  sock.incoming({ id: 'M1', from: '999@lid', alt: '5511987654321@s.whatsapp.net', text: 'oi' })
  sock.incoming({ id: 'M2', from: '1203@g.us', text: 'grupo' })
  sock.incoming({ id: 'M3', from: '5511987654321@s.whatsapp.net', text: 'eu mesma', fromMe: true })
  await tick(20)
  const inb = db.calls.filter((c) => c.inbound).map((c) => c.inbound)
  assert.equal(inb.length, 1)
  assert.equal(inb[0].remoteJid, '5511987654321@s.whatsapp.net')
  assert.equal(inb[0].body, 'oi')
})

test('(W4, ligado) confirmação de entrega e leitura vai para o banco', async () => {
  const s = make(withMessaging); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  FakeHub.last().receipt('OUT-1', 3); FakeHub.last().receipt('OUT-1', 4); FakeHub.last().receipt('OUT-1', 2); await tick(20)
  assert.deepEqual(db.calls.filter((c) => c.status).map((c) => c.status[1]), ['delivered', 'read'])
})

test('(W5, desligado em produção) envio: sem conexão recusa; conectado envia ao JID confirmado; número sem WhatsApp é erro definitivo', async () => {
  const s = make(); await s.start()
  await assert.rejects(() => s.send({ id: 'o1', to_phone: '5511987654321', body: 'oi' }), /não conectada/)
  FakeHub.last().scanAndOpen(); await tick(20)
  const id = await s.send({ id: 'o1', to_phone: '5511987654321', body: 'oi' })
  assert.equal(id, messageIdFor('o1'), 'id da mensagem = derivado do pedido da fila')
  assert.equal(FakeHub.last().sent[0].jid, '5511987654321@s.whatsapp.net')
  FakeHub.notOnWhatsApp.add('5511900001111')
  await assert.rejects(() => s.send({ id: 'o2', to_phone: '5511900001111', body: 'oi' }), (e) => e instanceof NonRetryableError)
})

test('(W5, desligado em produção) ritmo de envio: duas mensagens respeitam o intervalo mínimo', async () => {
  const s = make({ ...config, sendIntervalMs: 120 }); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  const t0 = Date.now()
  await Promise.all([s.send({ id: 'oa', to_phone: '5511987654321', body: 'a' }), s.send({ id: 'ob', to_phone: '5511987654321', body: 'b' })])
  assert.ok(Date.now() - t0 >= 110)
  assert.deepEqual(FakeHub.last().sent.map((m) => m.content.text), ['a', 'b'])
})

test('desconectar a pedido: logout, credenciais apagadas no banco, estado desconectado', async () => {
  const s = make(); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  await s.logoutAndStop()
  assert.ok(FakeHub.last().loggedOut)
  const st = db.states()
  assert.deepEqual(st.slice(-2), ['logged_out', 'disconnected'])
  assert.equal(stopped, 'disconnect_requested')
})

test('encerramento limpo: fecha o socket SEM logout e libera a posse', async () => {
  const s = make(); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  await s.stop({ reason: 'shutdown' })
  assert.ok(FakeHub.last().ended)
  assert.ok(!FakeHub.last().loggedOut)
  assert.ok(db.calls.includes('releaseLease'))
  assert.equal(s.state, 'stopped')
})

test('falha do banco ao gravar QR não derruba a sessão', async () => {
  const s = make(); await s.start()
  db.fail = 1
  FakeHub.last().emitQr('QR-X'); await tick()
  assert.equal(s.state, 'connecting')
  FakeHub.last().emitQr('QR-Y'); await tick()
  assert.ok(db.calls.some((c) => c.putQr === 'QR-Y'))
})

test('(W4) contato só com LID: usa o número do mapa LID do Baileys; sem mapa, grava o LID sem inventar número', async () => {
  const s = make({ ...config, messagingEnabled: true }); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  FakeHub.lidMap.set('999000111@lid', '5511987654321:3@s.whatsapp.net')
  FakeHub.last().incoming({ id: 'L1', from: '999000111@lid', text: 'SAIR' }); await tick(20)
  FakeHub.last().incoming({ id: 'L2', from: '888000222@lid', text: 'oi' }); await tick(20)
  const got = db.calls.filter((c) => c.inbound).map((c) => [c.inbound.waMessageId, c.inbound.remoteJid])
  assert.deepEqual(got, [['L1', '5511987654321@s.whatsapp.net'], ['L2', '888000222@lid']])
})

test('(W4) sincronização inicial/histórico: nada é gravado nem bloqueia ninguém (nem um SAIR antigo); só mensagem NOVA conta', async () => {
  const s = make({ ...config, messagingEnabled: true }); await s.start(); FakeHub.last().scanAndOpen(); await tick(20)
  const sock = FakeHub.last()
  const old = (id, text) => ({ key: { id, remoteJid: '5511987654321@s.whatsapp.net', fromMe: false }, message: { conversation: text }, messageTimestamp: 1700000000 })
  // como o Baileys entrega histórico: evento próprio e/ou upsert do tipo 'append'
  sock.ev.emit('messaging-history.set', { messages: [old('H1', 'SAIR'), old('H2', 'oi')], chats: [], contacts: [], isLatest: true })
  sock.ev.emit('messages.upsert', { type: 'append', messages: [old('H3', 'SAIR'), old('H4', 'oi')] })
  await tick(20)
  assert.equal(db.calls.filter((c) => c.inbound).length, 0, 'mensagem de histórico foi gravada')
  sock.incoming({ id: 'N1', from: '5511987654321@s.whatsapp.net', text: 'oi agora' }); await tick(20)
  assert.deepEqual(db.calls.filter((c) => c.inbound).map((c) => c.inbound.waMessageId), ['N1'], 'mensagem nova deve ser gravada')
})
