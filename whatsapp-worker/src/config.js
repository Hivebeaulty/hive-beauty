// Configuração vinda do ambiente (Discloud: arquivo .env enviado junto, nunca no Git).
// Falha cedo e com mensagem clara. Proteções:
//  - provedor falso (testes) só com NODE_ENV=test;
//  - banco SEM SSL verificado só com NODE_ENV=test;
//  - mensagens (receber/enviar) DESLIGADAS por padrão; só se ligam JUNTAS
//    (nunca enviar sem estar ouvindo SAIR/PARAR/STOP).
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'

export function loadEnvFile(path = '.env') {
  if (existsSync(path) && typeof process.loadEnvFile === 'function') process.loadEnvFile(path)
}

const int = (env, name, def, min, max) => {
  const raw = env[name]
  const n = raw === undefined || raw === '' ? def : Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} inválido: use um inteiro entre ${min} e ${max}.`)
  return n
}

export function readConfig(env = process.env) {
  for (const k of ['DATABASE_URL', 'WA_MASTER_KEY']) {
    if (!env[k]) throw new Error(`${k} é obrigatório.`)
  }
  const isTest = env.NODE_ENV === 'test'
  const provider = env.WA_PROVIDER || 'baileys'
  if (!['baileys', 'fake'].includes(provider)) throw new Error('WA_PROVIDER deve ser "baileys".')
  if (provider === 'fake' && !isTest) throw new Error('O provedor falso só pode ser usado com NODE_ENV=test.')

  const dbSsl = env.DB_SSL || 'verify'
  if (!['verify', 'off'].includes(dbSsl)) throw new Error('DB_SSL deve ser "verify".')
  if (dbSsl === 'off' && !isTest) throw new Error('Banco sem SSL só é permitido com NODE_ENV=test.')
  if (dbSsl === 'verify' && !env.DB_SSL_CA_FILE) {
    throw new Error('DB_SSL_CA_FILE é obrigatório (certificado do banco para verificar o SSL).')
  }

  return {
    databaseUrl: env.DATABASE_URL,
    masterKeyB64: env.WA_MASTER_KEY,
    keyVersion: int(env, 'WA_KEY_VERSION', 1, 1, 100),
    workerId: env.WORKER_ID || `${hostname()}-${process.pid}`,
    provider,
    dbSsl,
    dbSslCaFile: env.DB_SSL_CA_FILE || null,
    dbPoolMax: int(env, 'DB_POOL_MAX', 3, 1, 10),
    tickMs: int(env, 'TICK_MS', 3000, 100, 60000),
    leaseTtlSec: int(env, 'LEASE_TTL_SECONDS', 60, 10, 300),
    shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 10000, 1000, 60000),
    maxQrCycles: int(env, 'MAX_QR_CYCLES', 5, 1, 20),
    maxSessions: int(env, 'MAX_SESSIONS', 50, 1, 500),
    outboxBatch: int(env, 'OUTBOX_BATCH', 10, 1, 100),
    outboxLockSec: int(env, 'OUTBOX_LOCK_SECONDS', 60, 10, 600),
    reconnectBaseMs: int(env, 'RECONNECT_BASE_MS', 2000, 10, 60000),
    reconnectMaxMs: int(env, 'RECONNECT_MAX_MS', 60000, 100, 600000),
    sendIntervalMs: int(env, 'SEND_INTERVAL_MS', 3000, 0, 60000),
    // Receber e enviar andam juntos. Ligar só com autorização (roteiro de implantação W5).
    messagingEnabled: env.WA_MESSAGING_ENABLED === 'true',
    logLevel: env.LOG_LEVEL || 'info',
  }
}
