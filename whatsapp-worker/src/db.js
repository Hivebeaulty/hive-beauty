// Acesso ao banco: SÓ as funções do schema whatsapp_private concedidas ao papel
// wa_worker (migration 0017). Nenhuma tabela é lida ou escrita diretamente.
import { readFileSync } from 'node:fs'
import pg from 'pg'

export function createPool(config) {
  const ssl = config.dbSsl === 'verify'
    ? { ca: readFileSync(config.dbSslCaFile, 'utf8'), rejectUnauthorized: true }
    : false
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    application_name: 'aurea-wa-worker',
    statement_timeout: 30000,
  })
  // erro em conexão ociosa (ex.: banco reiniciou) não pode derrubar o processo
  pool.on('error', () => {})
  return pool
}

export class WorkerDb {
  constructor(pool, workerId) {
    this.pool = pool
    this.workerId = workerId
  }

  async #one(sql, params) {
    const r = await this.pool.query(sql, params)
    return r.rows[0] ? Object.values(r.rows[0])[0] : undefined
  }

  heartbeat(version) {
    return this.pool.query('select whatsapp_private.worker_heartbeat($1, $2)', [this.workerId, version])
  }
  acquireLease(companyId, ttlSec) {
    return this.#one('select whatsapp_private.acquire_lease($1, $2, $3)', [companyId, this.workerId, ttlSec])
  }
  releaseLease(companyId) {
    return this.pool.query('select whatsapp_private.release_lease($1, $2)', [companyId, this.workerId])
  }
  async sessionsToRun() {
    return (await this.pool.query('select * from whatsapp_private.sessions_to_run()')).rows
  }
  setState(companyId, status, { phone = null, jid = null, error = null } = {}) {
    return this.pool.query('select whatsapp_private.set_session_state($1, $2, $3, $4, $5, $6)',
      [companyId, this.workerId, status, phone, jid, error])
  }
  putQr(companyId, qr) {
    return this.pool.query('select whatsapp_private.put_qr($1, $2, $3)', [companyId, this.workerId, qr])
  }
  async authRead(companyId, category, keyIds) {
    const r = await this.pool.query('select * from whatsapp_private.auth_read($1, $2, $3, $4)',
      [companyId, this.workerId, category, keyIds])
    return r.rows
  }
  authWrite(companyId, items) {
    return this.#one('select whatsapp_private.auth_write($1, $2, $3)', [companyId, this.workerId, JSON.stringify(items)])
  }
  // kinds: null = todos; W2 usa ['connect', 'disconnect'] (envios ficam na fila para a W5)
  async claimOutbox(limit, lockSec, kinds = null) {
    return (await this.pool.query('select * from whatsapp_private.claim_outbox($1, $2, $3, $4)', [this.workerId, limit, lockSec, kinds])).rows
  }
  completeOutbox(id, waMessageId = null) {
    return this.#one('select whatsapp_private.complete_outbox($1, $2, $3)', [id, this.workerId, waMessageId])
  }
  failOutbox(id, error, retryable) {
    return this.#one('select whatsapp_private.fail_outbox($1, $2, $3, $4)', [id, this.workerId, String(error).slice(0, 500), retryable])
  }
  recordInbound(companyId, { waMessageId, remoteJid, body, timestamp, type }) {
    return this.#one('select whatsapp_private.record_inbound($1, $2, $3, $4, $5, $6, $7)',
      [companyId, this.workerId, waMessageId, remoteJid, body, timestamp, type])
  }
  recordMessageStatus(companyId, waMessageId, status) {
    return this.#one('select whatsapp_private.record_message_status($1, $2, $3, $4)',
      [companyId, this.workerId, waMessageId, status])
  }
}
