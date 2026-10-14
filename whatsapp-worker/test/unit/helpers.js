// Banco falso em memória que imita as regras das funções do worker relevantes
// para testes unitários (o comportamento real do banco é testado na integração).
export class MemoryDb {
  constructor() { this.auth = new Map(); this.calls = []; this.fail = 0; this.workerId = 'w-test' }
  #maybeFail(name) { this.calls.push(name); if (this.fail > 0) { this.fail--; throw new Error(`falha simulada em ${name}`) } }
  async authRead(companyId, category, keyIds) {
    this.#maybeFail('authRead')
    return keyIds.filter((k) => this.auth.has(`${companyId}|${category}|${k}`))
      .map((k) => ({ key_id: k, ...this.auth.get(`${companyId}|${category}|${k}`) }))
  }
  async authWrite(companyId, items) {
    this.#maybeFail('authWrite')
    for (const it of items) {
      const k = `${companyId}|${it.category}|${it.key_id}`
      if (it.data == null) this.auth.delete(k)
      else {
        const data = Buffer.from(it.data, 'base64')
        if (data.length < 29) throw new Error('check_violation: dado curto demais')
        this.auth.set(k, { data, key_version: it.key_version ?? 1 })
      }
    }
    return items.length
  }
  async setState(companyId, status, extra = {}) { this.#maybeFail('setState'); this.calls.push({ setState: status, ...extra }) }
  async putQr(companyId, qr) { this.#maybeFail('putQr'); this.calls.push({ putQr: qr }) }
  async releaseLease() { this.#maybeFail('releaseLease') }
  async recordInbound(companyId, m) { this.#maybeFail('recordInbound'); this.calls.push({ inbound: m }); return { inserted: true, opted_out: false } }
  async recordMessageStatus(companyId, id, s) { this.#maybeFail('recordMessageStatus'); this.calls.push({ status: [id, s] }); return true }
  states() { return this.calls.filter((c) => c && c.setState).map((c) => c.setState) }
}

export const silentLogger = {
  child() { return silentLogger }, info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, level: 'silent',
}

export const baseConfig = { maxQrCycles: 3, sendIntervalMs: 0, leaseTtlSec: 60 }

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
