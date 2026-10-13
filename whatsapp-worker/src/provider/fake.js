// Provedor FALSO, só para testes (NODE_ENV=test). Imita a interface do socket do
// Baileys que o worker usa: ev.on/off, user, sendMessage, onWhatsApp, logout, end.
//
// Modo controlado (testes no mesmo processo): FakeHub.sockets guarda cada socket
// criado e o teste dispara eventos (qr, open, close, mensagem).
// Modo automático (FAKE_AUTO=1, testes com processo separado): sem credencial
// registrada → mostra QR e "escaneia" sozinho; com credencial → conecta direto.
import { EventEmitter } from 'node:events'
import { BufferJSON, initAuthCreds, proto } from 'baileys'

export const baileysUtils = { initAuthCreds, BufferJSON, proto }

export const FakeHub = {
  sockets: [],
  reset() { this.sockets = []; this.notOnWhatsApp = new Set(); this.sendFailures = 0; this.lidMap = new Map(); this.crashAfterSend = 0 },
  notOnWhatsApp: new Set(),
  sendFailures: 0,
  lidMap: new Map(),        // '123@lid' -> '5511...:0@s.whatsapp.net'
  crashAfterSend: 0,        // envia de verdade e DEPOIS falha (simula queda antes de registrar)
  last() { return this.sockets[this.sockets.length - 1] },
}

let seq = 0
export class FakeSocket {
  constructor({ auth }) {
    this.auth = auth
    this.ev = new EventEmitter()
    this.ev.setMaxListeners(50)
    this.user = undefined
    this.sent = []
    this.ended = false
    this.loggedOut = false
    this.id = ++seq
    this.signalRepository = { lidMapping: { getPNForLID: async (lid) => FakeHub.lidMap.get(lid) ?? null } }
  }
  emitQr(qr = `FAKE-QR-${this.id}-${Date.now()}`) { this.ev.emit('connection.update', { qr }) }
  scanAndOpen(phone = '5511900000000') {
    const c = this.auth.state.creds
    c.me = { id: `${phone}:7@s.whatsapp.net`, name: 'Teste' }
    c.registered = true
    this.ev.emit('creds.update', { me: c.me, registered: true })
    this.open()
  }
  open() {
    this.user = this.auth.state.creds.me
    this.ev.emit('connection.update', { connection: 'open' })
  }
  close(statusCode) {
    if (this.ended) return
    const error = Object.assign(new Error(`fake close ${statusCode}`), { output: { statusCode } })
    this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
  }
  incoming({ id, from, text, fromMe = false, alt } = {}) {
    this.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { id, remoteJid: from, remoteJidAlt: alt, fromMe }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }],
    })
  }
  receipt(id, status) {
    this.ev.emit('messages.update', [{ key: { id, fromMe: true, remoteJid: 'x@s.whatsapp.net' }, update: { status } }])
  }
  async onWhatsApp(...phones) {
    return phones.map((p) => ({ jid: `${String(p).replace(/\D/g, '')}@s.whatsapp.net`, exists: !FakeHub.notOnWhatsApp.has(String(p).replace(/\D/g, '')) }))
  }
  async sendMessage(jid, content, opts = {}) {
    if (FakeHub.sendFailures > 0) { FakeHub.sendFailures--; throw new Error('falha simulada de envio') }
    const id = opts.messageId || `FAKE-${this.id}-${this.sent.length + 1}-${Date.now()}`
    this.sent.push({ jid, content, id })
    if (FakeHub.crashAfterSend > 0) { FakeHub.crashAfterSend--; throw new Error('queda simulada depois do envio') }
    return { key: { id, remoteJid: jid, fromMe: true } }
  }
  async logout() { this.loggedOut = true; this.close(401) }
  async end() { this.ended = true }
}

export function createSocket({ auth }) {
  const sock = new FakeSocket({ auth })
  FakeHub.sockets.push(sock)
  if (process.env.FAKE_AUTO === '1') {
    setTimeout(() => {
      if (sock.ended) return
      if (auth.state.creds.registered) sock.open()
      else { sock.emitQr(); setTimeout(() => !sock.ended && sock.scanAndOpen(process.env.FAKE_PHONE || '5511900000000'), 300) }
    }, 50)
  }
  return sock
}

export function selfIdentity(sock) {
  const id = sock?.user?.id
  if (!id) return { phone: null, jid: null }
  const user = id.split('@')[0].split(':')[0]
  return { phone: user, jid: `${user}@s.whatsapp.net` }
}
