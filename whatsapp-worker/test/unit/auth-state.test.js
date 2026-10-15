import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { BufferJSON, initAuthCreds, proto } from 'baileys'
import { useDbAuthState } from '../../src/auth-state.js'
import { MemoryDb } from './helpers.js'

const baileys = { BufferJSON, initAuthCreds, proto }
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

test('sem credencial: cria credenciais novas (initAuthCreds do Baileys real)', async () => {
  const db = new MemoryDb()
  const a = await useDbAuthState({ db, companyId: A, masterKey: randomBytes(32), baileys })
  assert.equal(a.hadCreds, false)
  assert.ok(Buffer.isBuffer(a.state.creds.noiseKey.private))
})

test('salvar e restaurar após "reinício": credenciais idênticas, Buffers preservados', async () => {
  const db = new MemoryDb(); const masterKey = randomBytes(32)
  const a = await useDbAuthState({ db, companyId: A, masterKey, baileys })
  a.state.creds.me = { id: '5511900000000:7@s.whatsapp.net' }
  a.state.creds.registered = true
  await a.saveCreds()
  const b = await useDbAuthState({ db, companyId: A, masterKey, baileys })
  assert.equal(b.hadCreds, true)
  assert.deepEqual(JSON.stringify(b.state.creds, BufferJSON.replacer), JSON.stringify(a.state.creds, BufferJSON.replacer))
  assert.ok(Buffer.isBuffer(b.state.creds.signedIdentityKey.private))
})

test('o banco só recebe bytes cifrados (nada do JSON original aparece)', async () => {
  const db = new MemoryDb()
  const a = await useDbAuthState({ db, companyId: A, masterKey: randomBytes(32), baileys })
  a.state.creds.me = { id: 'NUMERO-SECRETO@s.whatsapp.net' }
  await a.saveCreds()
  const stored = [...db.auth.values()][0].data
  assert.ok(!stored.includes(Buffer.from('NUMERO-SECRETO')))
  assert.ok(!stored.includes(Buffer.from('noiseKey')))
})

test('chaves: grava, lê, apaga; app-state-sync-key volta como objeto proto', async () => {
  const db = new MemoryDb()
  const a = await useDbAuthState({ db, companyId: A, masterKey: randomBytes(32), baileys })
  await a.state.keys.set({ 'pre-key': { 1: { public: Buffer.from('pub'), private: Buffer.from('priv') } },
                           'app-state-sync-key': { K1: { keyData: Buffer.from('kd') } } })
  const pk = await a.state.keys.get('pre-key', ['1', '2'])
  assert.deepEqual(pk['1'].public, Buffer.from('pub'))
  assert.equal(pk['2'], undefined)
  const sk = await a.state.keys.get('app-state-sync-key', ['K1'])
  assert.ok(sk.K1 instanceof proto.Message.AppStateSyncKeyData)
  await a.state.keys.set({ 'pre-key': { 1: null } })
  assert.deepEqual(await a.state.keys.get('pre-key', ['1']), {})
})

test('credenciais de uma empresa não abrem com a chave de outra (linha copiada)', async () => {
  const db = new MemoryDb(); const masterKey = randomBytes(32)
  const a = await useDbAuthState({ db, companyId: A, masterKey, baileys })
  await a.saveCreds()
  db.auth.set(`${B}|creds|creds`, db.auth.get(`${A}|creds|creds`))
  await assert.rejects(() => useDbAuthState({ db, companyId: B, masterKey, baileys }))
})

test('chave-mestra trocada: falha ao abrir (não usa credencial errada em silêncio)', async () => {
  const db = new MemoryDb()
  const a = await useDbAuthState({ db, companyId: A, masterKey: randomBytes(32), baileys })
  await a.saveCreds()
  await assert.rejects(() => useDbAuthState({ db, companyId: A, masterKey: randomBytes(32), baileys }))
})

test('gravações em ordem: a última versão das credenciais é a que fica', async () => {
  const db = new MemoryDb(); const masterKey = randomBytes(32)
  const a = await useDbAuthState({ db, companyId: A, masterKey, baileys })
  for (let i = 0; i < 20; i++) { a.state.creds.nextPreKeyId = i; a.saveCreds() }
  await a.flush()
  const b = await useDbAuthState({ db, companyId: A, masterKey, baileys })
  assert.equal(b.state.creds.nextPreKeyId, 19)
})

test('falha do banco ao gravar não trava as gravações seguintes', async () => {
  const db = new MemoryDb(); const masterKey = randomBytes(32)
  const a = await useDbAuthState({ db, companyId: A, masterKey, baileys })
  db.fail = 1
  await assert.rejects(() => a.saveCreds())
  a.state.creds.nextPreKeyId = 99
  await a.saveCreds()
  const b = await useDbAuthState({ db, companyId: A, masterKey, baileys })
  assert.equal(b.state.creds.nextPreKeyId, 99)
})

test('encerramento seguro (drain): parado termina logo; espera atividade tardia; respeita o limite', async () => {
  const db = new MemoryDb()
  const a = await useDbAuthState({ db, companyId: A, masterKey: randomBytes(32), baileys })
  // parado: silencia em ~quietMs
  let t = Date.now()
  assert.equal(await a.drain({ quietMs: 50, maxMs: 1000 }), true)
  assert.ok(Date.now() - t < 400)
  // gravação tardia (como a biblioteca faz ao fechar): a espera só termina DEPOIS dela
  setTimeout(() => { a.state.keys.set({ session: { tardia: { x: 1 } } }) }, 80)
  t = Date.now()
  assert.equal(await a.drain({ quietMs: 150, maxMs: 2000 }), true)
  const got = await a.state.keys.get('session', ['tardia'])
  assert.deepEqual(got.tardia, { x: 1 }, 'gravação tardia concluída antes do fim da espera')
  // atividade sem parar: desiste no limite (o encerramento nunca fica preso)
  const iv = setInterval(() => { a.state.keys.get('session', ['tardia']) }, 20)
  t = Date.now()
  const quiet = await a.drain({ quietMs: 200, maxMs: 300 })
  clearInterval(iv)
  assert.equal(quiet, false)
  assert.ok(Date.now() - t < 700, 'respeitou o limite')
})
