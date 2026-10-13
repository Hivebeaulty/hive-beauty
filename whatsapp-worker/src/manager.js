// Gerente das sessões deste worker. A cada volta (tick):
//   1. batimento do worker;
//   2. renova a posse das sessões que já roda (perdeu a posse → para na hora);
//   3. assume sessões que precisam rodar e estão livres;
//   4. processa a fila (conectar, desconectar, enviar).
// Falha de banco numa volta não derruba o processo: registra e tenta na próxima.
// Se não conseguir renovar a posse por quase todo o prazo, para a sessão por
// segurança (outro worker pode assumir; nunca dois conectados ao mesmo número).
import { CompanySession, NonRetryableError } from './session.js'
import { redactDigits } from './logger.js'

const RUNNABLE = new Set(['connect_requested', 'qr_pending', 'connecting', 'connected'])

export class SessionManager {
  constructor({ db, config, logger, createSession, version = '0.1.0', now = () => Date.now() }) {
    this.db = db
    this.config = config
    this.log = logger
    this.createSession = createSession     // (companyId, onStopped) => CompanySession
    this.version = version
    this.now = now
    this.sessions = new Map()              // companyId -> { session, lastRenewOk }
    this.timer = null
    this.running = false
    this.ticking = null
    this.consecutiveDbErrors = 0
  }

  start() {
    this.running = true
    const loop = async () => {
      if (!this.running) return
      this.ticking = this.tick().catch((e) => this.log.error({ err: e.message }, 'falha na volta'))
      await this.ticking
      this.ticking = null
      if (this.running) { this.timer = setTimeout(loop, this.config.tickMs); this.timer.unref?.() }
    }
    loop()
  }

  async tick() {
    try {
      await this.db.heartbeat(this.version)
      await this.#renewLeases()
      await this.#adoptSessions()
      await this.#processOutbox()
      if (this.consecutiveDbErrors > 0) this.log.info({ after: this.consecutiveDbErrors }, 'banco voltou')
      this.consecutiveDbErrors = 0
    } catch (e) {
      this.consecutiveDbErrors += 1
      this.log.error({ err: e.message, code: e.code, n: this.consecutiveDbErrors }, 'banco indisponível nesta volta')
      this.#enforceLeaseSafety()
    }
  }

  async #renewLeases() {
    for (const [companyId, entry] of this.sessions) {
      let ok = false
      try { ok = await this.db.acquireLease(companyId, this.config.leaseTtlSec) } catch (e) { this.#enforceLeaseSafety(); throw e }
      if (ok) entry.lastRenewOk = this.now()
      else {
        this.log.warn({ company: companyId }, 'posse perdida para outro worker: parando a sessão')
        this.sessions.delete(companyId)
        await entry.session.stop({ reason: 'lease_lost', release: false })
      }
    }
  }

  #enforceLeaseSafety() {
    const limit = this.config.leaseTtlSec * 1000 * 0.8
    for (const [companyId, entry] of this.sessions) {
      if (this.now() - entry.lastRenewOk > limit) {
        this.log.warn({ company: companyId }, 'sem renovar a posse há muito tempo: parando a sessão por segurança')
        this.sessions.delete(companyId)
        entry.session.stop({ reason: 'lease_unconfirmed', release: false }).catch(() => {})
      }
    }
  }

  async #adoptSessions() {
    const rows = await this.db.sessionsToRun()
    const now = new Date()
    for (const row of rows) {
      if (this.sessions.has(row.company_id)) continue
      if (!RUNNABLE.has(row.status) && row.status !== 'disconnect_requested') continue
      if (row.lease_owner && row.lease_owner !== this.db.workerId && row.lease_until && new Date(row.lease_until) > now) continue
      if (this.sessions.size >= this.config.maxSessions) { this.log.warn('limite de sessões deste worker atingido'); break }
      if (!(await this.db.acquireLease(row.company_id, this.config.leaseTtlSec))) continue

      if (row.status === 'disconnect_requested' && !row.has_auth) {
        // nada a deslogar: a fila conclui o pedido de desconexão na volta abaixo
        this.sessions.set(row.company_id, { session: null, lastRenewOk: this.now() })
        continue
      }
      if ((row.status === 'connected' || row.status === 'connecting') && !row.has_auth) {
        await this.db.setState(row.company_id, 'disconnected', { error: 'Credenciais ausentes: conecte de novo' })
        await this.db.releaseLease(row.company_id)
        continue
      }
      this.#startSession(row.company_id)
    }
  }

  #startSession(companyId) {
    const session = this.createSession(companyId, (id) => {
      const cur = this.sessions.get(id)
      if (cur?.session === session) this.sessions.delete(id)
    })
    this.sessions.set(companyId, { session, lastRenewOk: this.now() })
    session.start().catch((e) => this.log.error({ company: companyId, err: e.message }, 'falha ao iniciar a sessão'))
    return session
  }

  async #processOutbox() {
    const kinds = this.config.messagingEnabled ? null : ['connect', 'disconnect']
    const items = await this.db.claimOutbox(this.config.outboxBatch, this.config.outboxLockSec, kinds)
    await Promise.all(items.map((it) => this.#handle(it)))
  }

  async #handle(item) {
    const entry = this.sessions.get(item.company_id)
    try {
      if (item.kind === 'connect') {
        if (!entry?.session) this.#startSession(item.company_id)
        await this.db.completeOutbox(item.id)
      } else if (item.kind === 'disconnect') {
        if (entry?.session) { this.sessions.delete(item.company_id); await entry.session.logoutAndStop() }
        else {
          await this.db.setState(item.company_id, 'logged_out')
          await this.db.setState(item.company_id, 'disconnected')
          this.sessions.delete(item.company_id)
        }
        await this.db.completeOutbox(item.id)
        await this.db.releaseLease(item.company_id).catch(() => {})
      } else if (item.kind === 'send_text') {
        if (!entry?.session?.isOpen) throw new Error('sessão não conectada')
        const waId = await entry.session.send(item)
        await this.db.completeOutbox(item.id, waId)
      }
    } catch (e) {
      const retryable = !(e instanceof NonRetryableError)
      this.log.warn({ outbox: item.id, kind: item.kind, retryable, err: e.message }, 'pedido não concluído')
      try { await this.db.failOutbox(item.id, redactDigits(e.message), retryable) } catch (e2) { this.log.error({ err: e2.message }, 'falha ao registrar erro do pedido') }
    }
  }

  // Encerramento limpo: para a volta, encerra sessões SEM logout e libera as posses.
  async shutdown() {
    this.running = false
    clearTimeout(this.timer)
    if (this.ticking) await this.ticking.catch(() => {})
    const all = [...this.sessions.entries()]
    this.sessions.clear()
    await Promise.all(all.map(async ([companyId, e]) => {
      if (e.session) await e.session.stop({ reason: 'shutdown' })
      else await this.db.releaseLease(companyId).catch(() => {})
    }))
  }
}

export function makeSessionFactory({ db, provider, authFactory, logger, config }) {
  return (companyId, onStopped) => new CompanySession({ companyId, db, provider, authFactory, logger, config, onStopped })
}
