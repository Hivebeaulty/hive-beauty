// Uma sessão de WhatsApp de UMA empresa, enquanto este worker detém a posse dela.
//
// Ciclo: start() abre o socket com as credenciais do banco → QR (se não houver
// credencial) → aberto → [queda → reconecta com espera crescente] → stop().
// Tudo o que muda de estado vai para o banco pelas funções do worker.
import { nextDelayMs } from './backoff.js'
import { maskPhone } from './logger.js'
import {
  classifyClose, closeStatusCode, extractText, isIgnorableJid, mapStatus, messageIdFor, normalizePnJid, phoneToJid,
  pickRemoteJid,
} from './wa-utils.js'

export class NonRetryableError extends Error {}

export class CompanySession {
  constructor({ companyId, db, provider, authFactory, logger, config, onStopped = () => {} }) {
    this.companyId = companyId
    this.db = db
    this.provider = provider            // { createSocket, selfIdentity }
    this.authFactory = authFactory      // (companyId) => useDbAuthState(...)
    this.log = logger.child({ company: companyId })
    this.config = config
    this.onStopped = onStopped
    this.sock = null
    this.auth = null
    this.state = 'idle'                 // idle | connecting | open | stopping | stopped
    this.attempt = 0
    this.qrCycles = 0
    this.reconnectTimer = null
    this.lastSendAt = 0
    this.sendChain = Promise.resolve()
    this.generation = 0                 // ignora eventos de sockets antigos
  }

  get isOpen() { return this.state === 'open' }
  get isActive() { return this.state !== 'stopping' && this.state !== 'stopped' }

  async start() {
    if (!this.isActive) return
    this.state = 'connecting'
    const gen = ++this.generation
    this.auth = await this.authFactory(this.companyId)
    if (!this.isActive || gen !== this.generation) return
    if (!this.auth.hadCreds) this.log.info('sem credencial: vai gerar QR')
    await this.#safe(() => this.db.setState(this.companyId, 'connecting'), 'estado connecting')
    const sock = this.provider.createSocket({ auth: this.auth, logger: this.log.child({ lib: 'baileys' }, { level: 'warn' }) })
    this.sock = sock
    sock.ev.on('creds.update', () => {
      if (gen !== this.generation) return
      this.auth.saveCreds().catch((e) => this.log.error({ err: e.message }, 'falha ao gravar credenciais'))
    })
    sock.ev.on('connection.update', (u) => { if (gen === this.generation) this.#onConnection(u).catch((e) => this.log.error({ err: e.message }, 'erro em connection.update')) })
    if (this.config.messagingEnabled) {   // W4/W5: receber e enviar andam JUNTOS (sem ouvir SAIR, não envia)
      sock.ev.on('messages.upsert', (u) => { if (gen === this.generation) this.#onMessages(u).catch((e) => this.log.error({ err: e.message }, 'erro em messages.upsert')) })
      sock.ev.on('messages.update', (u) => { if (gen === this.generation) this.#onReceipts(u).catch((e) => this.log.error({ err: e.message }, 'erro em messages.update')) })
    }
  }

  async #onConnection({ connection, lastDisconnect, qr }) {
    if (!this.isActive) return
    if (qr) {
      this.qrCycles += 1
      if (this.qrCycles > this.config.maxQrCycles) {
        this.log.warn({ cycles: this.qrCycles }, 'QR não escaneado a tempo')
        await this.#safe(() => this.db.setState(this.companyId, 'disconnected', { error: 'QR não escaneado a tempo' }), 'estado qr expirado')
        await this.stop({ reason: 'qr_timeout' })
        return
      }
      await this.#safe(() => this.db.putQr(this.companyId, qr), 'gravar QR')
      return
    }
    if (connection === 'open') {
      this.state = 'open'
      this.attempt = 0
      this.qrCycles = 0
      const me = this.provider.selfIdentity(this.sock)
      this.log.info({ phone: maskPhone(me.phone) }, 'conectado')
      await this.#safe(() => this.db.setState(this.companyId, 'connected', { phone: me.phone, jid: me.jid }), 'estado connected')
      return
    }
    if (connection === 'close') {
      const code = closeStatusCode(lastDisconnect)
      const kind = classifyClose(code)
      this.log.warn({ code, kind }, 'conexão fechada')
      this.state = 'connecting'
      if (kind === 'logged_out') {
        // credenciais inválidas: o banco apaga credenciais e QR; precisa novo QR
        await this.#safe(() => this.db.setState(this.companyId, 'logged_out'), 'estado logged_out')
        await this.stop({ reason: 'logged_out' })
      } else if (kind === 'replaced' || kind === 'forbidden') {
        const msg = kind === 'replaced' ? 'Sessão aberta em outro lugar' : 'Acesso negado pelo WhatsApp'
        await this.#safe(() => this.db.setState(this.companyId, 'error', { error: msg }), 'estado error')
        await this.stop({ reason: kind })
      } else {
        this.#scheduleReconnect(kind === 'restart' ? 0 : this.#delay())
      }
    }
  }

  #scheduleReconnect(delayMs) {
    if (!this.isActive) return
    clearTimeout(this.reconnectTimer)
    this.log.info({ delayMs, attempt: this.attempt }, 'reconectando')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.generation++   // eventos do socket antigo (inclusive o "close" do end) passam a ser ignorados
      this.#closeSocket().then(() => this.start()).catch((e) => {
        this.log.error({ err: e.message }, 'falha ao reconectar')
        this.#scheduleReconnect(this.#delay())
      })
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  #delay() {
    return nextDelayMs(this.attempt++, { baseMs: this.config.reconnectBaseMs ?? 2000, maxMs: this.config.reconnectMaxMs ?? 60000 })
  }

  async #onMessages({ messages = [], type }) {
    if (type !== 'notify') return   // ignora histórico/sincronização
    for (const msg of messages) {
      const key = msg?.key
      if (!key?.id || key.fromMe || !msg.message) continue
      let remoteJid = pickRemoteJid(key)
      if (isIgnorableJid(remoteJid)) continue
      if (remoteJid.endsWith('@lid')) remoteJid = (await this.#pnForLid(remoteJid)) || remoteJid
      const { text, type: msgType } = extractText(msg.message)
      const ts = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : null
      const r = await this.db.recordInbound(this.companyId, { waMessageId: key.id, remoteJid, body: text, timestamp: ts, type: msgType })
      if (r?.opted_out) this.log.info('cliente pediu para sair')
    }
  }

  // Contato identificado só por LID (sem número): pergunta ao mapa do próprio
  // Baileys. Sem mapa, a mensagem fica registrada sem cliente (regra da 0017).
  async #pnForLid(lid) {
    try {
      return normalizePnJid(await this.sock?.signalRepository?.lidMapping?.getPNForLID?.(lid))
    } catch (e) {
      this.log.warn({ err: e.message }, 'mapa LID indisponível')
      return null
    }
  }

  async #onReceipts(updates = []) {
    for (const { key, update } of updates) {
      if (!key?.fromMe || update?.status == null) continue
      const s = mapStatus(update.status)
      if (s) await this.db.recordMessageStatus(this.companyId, key.id, s)
    }
  }

  // Envio de texto, com ritmo mínimo entre mensagens desta empresa.
  send(item) {
    const p = this.sendChain.then(() => this.#sendNow(item))
    this.sendChain = p.catch(() => {})
    return p
  }

  async #sendNow({ id, to_phone: toPhone, body }) {
    if (!this.isOpen || !this.sock) throw new Error('sessão não conectada')
    const wait = this.lastSendAt + this.config.sendIntervalMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    // confirma o número no WhatsApp e usa o identificador que ele devolve
    // (resolve celulares registrados com ou sem o 9º dígito)
    const [res] = (await this.sock.onWhatsApp(phoneToJid(toPhone).split('@')[0])) || []
    if (!res?.exists) throw new NonRetryableError('número sem WhatsApp')
    const sent = await this.sock.sendMessage(res.jid, { text: body }, { messageId: messageIdFor(id) })
    this.lastSendAt = Date.now()
    if (!sent?.key?.id) throw new Error('envio sem id de mensagem')
    return sent.key.id
  }

  // Desconectar a pedido da empresa: sai do WhatsApp e apaga as credenciais.
  async logoutAndStop() {
    this.log.info('desconectando a pedido da empresa')
    this.state = 'stopping'
    try { await this.sock?.logout() } catch (e) { this.log.warn({ err: e.message }, 'logout falhou (seguindo)') }
    // logged_out apaga credenciais e QR no banco; em seguida fica "disconnected"
    await this.#safe(() => this.db.setState(this.companyId, 'logged_out'), 'estado logged_out')
    await this.#safe(() => this.db.setState(this.companyId, 'disconnected'), 'estado disconnected')
    await this.stop({ reason: 'disconnect_requested' })
  }

  // Encerramento limpo: NÃO faz logout (credenciais continuam válidas para reconectar).
  async stop({ reason = 'stop', release = true } = {}) {
    if (this.state === 'stopped') return
    this.state = 'stopping'
    this.generation++
    clearTimeout(this.reconnectTimer)
    await this.#closeSocket()
    // Encerramento seguro: a biblioteca pode concluir gravações de chaves logo
    // depois de a conexão fechar. Esperamos ela silenciar (com limite) ANTES de
    // devolver a posse; senão essas gravações seriam recusadas e perdidas.
    if (this.auth?.drain) {
      const quiet = await this.auth.drain({ quietMs: this.config.shutdownQuietMs ?? 500, maxMs: this.config.shutdownDrainMs ?? 3000 })
      if (!quiet) this.log.warn('credenciais ainda em gravação ao encerrar (limite de espera atingido)')
    }
    try { await this.auth?.flush() } catch (e) { this.log.warn({ err: e.message }, 'credenciais pendentes não gravadas') }
    if (release) await this.#safe(() => this.db.releaseLease(this.companyId), 'liberar posse')
    this.state = 'stopped'
    this.log.info({ reason }, 'sessão encerrada')
    this.onStopped(this.companyId, reason)
  }

  async #closeSocket() {
    const s = this.sock
    this.sock = null
    if (s) { try { await s.end(undefined) } catch { /* já fechado */ } }
  }

  async #safe(fn, what) {
    try { return await fn() } catch (e) { this.log.error({ err: e.message, code: e.code }, `falha no banco: ${what}`) }
  }
}
