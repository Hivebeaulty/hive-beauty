import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyClose, extractText, isIgnorableJid, isOptOutWord, mapStatus, phoneToJid, pickRemoteJid } from '../../src/wa-utils.js'
import { nextDelayMs } from '../../src/backoff.js'
import { maskPhone } from '../../src/logger.js'

test('telefone -> JID', () => {
  assert.equal(phoneToJid('5511987654321'), '5511987654321@s.whatsapp.net')
  assert.throws(() => phoneToJid('123'))
})
test('remetente: prefere o identificador com número quando a mensagem vem por LID', () => {
  assert.equal(pickRemoteJid({ remoteJid: '123@lid', remoteJidAlt: '5511987654321@s.whatsapp.net' }), '5511987654321@s.whatsapp.net')
  assert.equal(pickRemoteJid({ remoteJid: '123@lid' }), '123@lid')
  assert.equal(pickRemoteJid({ remoteJid: '5511987654321@s.whatsapp.net' }), '5511987654321@s.whatsapp.net')
})
test('grupos, status e canais são ignorados', () => {
  for (const j of ['1203@g.us', 'status@broadcast', 'x@newsletter']) assert.ok(isIgnorableJid(j))
  assert.ok(!isIgnorableJid('5511987654321@s.whatsapp.net'))
})
test('texto: comum, estendido, legenda, efêmera, áudio', () => {
  assert.deepEqual(extractText({ conversation: 'oi' }), { text: 'oi', type: 'text' })
  assert.deepEqual(extractText({ extendedTextMessage: { text: 'link' } }), { text: 'link', type: 'text' })
  assert.deepEqual(extractText({ imageMessage: { caption: 'foto' } }), { text: 'foto', type: 'image' })
  assert.deepEqual(extractText({ ephemeralMessage: { message: { conversation: 'sumo' } } }), { text: 'sumo', type: 'text' })
  assert.deepEqual(extractText({ audioMessage: {} }), { text: null, type: 'audio' })
})
test('confirmações: entregue, lida, falha; o resto é ignorado', () => {
  assert.equal(mapStatus(3), 'delivered'); assert.equal(mapStatus(4), 'read'); assert.equal(mapStatus(5), 'read')
  assert.equal(mapStatus(0), 'failed'); assert.equal(mapStatus(2), null); assert.equal(mapStatus(1), null)
})
test('fechamento: o que fazer em cada código do WhatsApp', () => {
  assert.equal(classifyClose(401), 'logged_out'); assert.equal(classifyClose(500), 'logged_out')
  assert.equal(classifyClose(440), 'replaced'); assert.equal(classifyClose(403), 'forbidden')
  assert.equal(classifyClose(515), 'restart')
  for (const c of [408, 428, 503, null, 999]) assert.equal(classifyClose(c), 'reconnect')
})
test('palavras de saída iguais às do banco', () => {
  for (const w of ['SAIR', ' sair! ', 'Parar.', 'stop']) assert.ok(isOptOutWord(w), w)
  for (const w of ['posso sair mais cedo?', 'sairei', '']) assert.ok(!isOptOutWord(w), w)
})
test('espera entre tentativas: cresce, tem teto e variação limitada', () => {
  const mid = () => 0.5
  assert.equal(nextDelayMs(0, { random: mid }), 2000)
  assert.equal(nextDelayMs(1, { random: mid }), 4000)
  assert.equal(nextDelayMs(10, { random: mid }), 60000)
  for (let i = 0; i < 200; i++) { const d = nextDelayMs(3); assert.ok(d >= 12800 && d <= 19200, String(d)) }
})
test('telefone mascarado nos logs', () => {
  assert.equal(maskPhone('5511987654321'), '*********4321')
})

test('messageIdFor: mesmo pedido → mesmo id (retry não gera mensagem nova); formato do Baileys', async () => {
  const { messageIdFor } = await import('../../src/wa-utils.js')
  const a = messageIdFor('6b1f0c3e-0000-4000-8000-000000000001')
  assert.equal(a, messageIdFor('6b1f0c3e-0000-4000-8000-000000000001'))
  assert.notEqual(a, messageIdFor('6b1f0c3e-0000-4000-8000-000000000002'))
  assert.match(a, /^3EB0[0-9A-F]{18}$/)
  assert.throws(() => messageIdFor(null))
})

test('normalizePnJid: aceita número com ou sem dispositivo; recusa LID, grupo e lixo', async () => {
  const { normalizePnJid } = await import('../../src/wa-utils.js')
  assert.equal(normalizePnJid('5511987654321:12@s.whatsapp.net'), '5511987654321@s.whatsapp.net')
  assert.equal(normalizePnJid('5511987654321@s.whatsapp.net'), '5511987654321@s.whatsapp.net')
  for (const x of [null, undefined, '', '123@lid', '1203630@g.us', 'abc@s.whatsapp.net']) assert.equal(normalizePnJid(x), null)
})

test('logs: telefone/JID dentro de mensagem de erro sai mascarado; o resto da mensagem fica', async () => {
  const { redactDigits, createLogger } = await import('../../src/logger.js')
  assert.equal(redactDigits('falha ao enviar para 5511987654321@s.whatsapp.net'), 'falha ao enviar para *********4321@s.whatsapp.net')
  assert.equal(redactDigits('timeout 30000 ms'), 'timeout 30000 ms')
  const lines = []
  const { Writable } = await import('node:stream')
  const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb() } }))
  log.warn({ err: 'erro ao enviar para 5511987654321@s.whatsapp.net', body: 'Oi, Ana!' }, 'teste')
  const out = lines.join('')
  assert.ok(!out.includes('5511987654321'), 'telefone apareceu no log')
  assert.ok(!out.includes('Oi, Ana!'), 'texto da mensagem apareceu no log')
  assert.ok(out.includes('*********4321'))
})
