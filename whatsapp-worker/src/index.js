// Ponto de entrada do worker (Discloud: MAIN=src/index.js).
import { loadEnvFile, readConfig } from './config.js'
import { createLogger, guardConsole } from './logger.js'
import { loadMasterKey } from './crypto.js'
import { createPool, WorkerDb } from './db.js'
import { useDbAuthState } from './auth-state.js'
import { SessionManager, makeSessionFactory } from './manager.js'

const VERSION = '0.4.0'

async function main() {
  guardConsole()   // antes de carregar o Baileys: chaves da libsignal nunca vão para o log
  loadEnvFile()
  const config = readConfig()
  const log = createLogger(config.logLevel)
  const masterKey = loadMasterKey(config.masterKeyB64)
  const provider = config.provider === 'fake'
    ? await import('./provider/fake.js')
    : await import('./provider/baileys.js')

  const pool = createPool(config)
  const db = new WorkerDb(pool, config.workerId)
  const authFactory = (companyId) => useDbAuthState({ db, companyId, masterKey, keyVersion: config.keyVersion, baileys: provider.baileysUtils })
  const manager = new SessionManager({
    db, config, logger: log, version: VERSION,
    createSession: makeSessionFactory({ db, provider, authFactory, logger: log, config }),
  })

  let closing = false
  const shutdown = async (signal, code = 0) => {
    if (closing) return
    closing = true
    log.info({ signal }, 'encerrando')
    const force = setTimeout(() => { log.error('encerramento demorou demais: saindo à força'); process.exit(code || 1) }, config.shutdownTimeoutMs)
    try { await manager.shutdown() } catch (e) { log.error({ err: e.message }, 'erro no encerramento') }
    await pool.end().catch(() => {})
    clearTimeout(force)
    log.info('encerrado')
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (e) => log.error({ err: e?.message }, 'promessa rejeitada sem tratamento'))
  process.on('uncaughtException', (e) => { log.fatal({ err: e?.message }, 'erro fatal'); shutdown('uncaughtException', 1) })

  log.info({ worker: config.workerId, provider: config.provider, version: VERSION, pid: process.pid, ignoreGroups: config.ignoreGroups }, 'worker iniciado')
  await db.workerStarted(VERSION).catch((e) => log.warn({ err: e.message }, 'não registrou o início do processo (migration 0047 pendente?)'))
  manager.start()
}

main().catch((e) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'falha ao iniciar', err: e.message }))
  process.exit(1)
})
