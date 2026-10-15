// Credenciais do Baileys guardadas no banco, CIFRADAS por empresa.
// Mesma interface de useMultiFileAuthState (state.creds, state.keys.get/set, saveCreds),
// mas sem disco: um reinício ou redeploy reconecta sem pedir QR.
import { aadFor, companyKey, decrypt, encrypt } from './crypto.js'

export async function useDbAuthState({ db, companyId, masterKey, keyVersion = 1, baileys }) {
  const { initAuthCreds, BufferJSON, proto } = baileys
  const keys = new Map()
  const keyFor = (v) => {
    if (!keys.has(v)) keys.set(v, companyKey(masterKey, companyId, v))
    return keys.get(v)
  }

  const pack = (category, keyId, value) => encrypt(
    keyFor(keyVersion), Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8'), aadFor(companyId, category, keyId))
  const unpack = (category, keyId, row) => JSON.parse(
    decrypt(keyFor(row.key_version), row.data, aadFor(companyId, category, keyId)).toString('utf8'), BufferJSON.reviver)

  // gravações em ordem (creds e chaves nunca se atropelam)
  let chain = Promise.resolve()
  const serial = (fn) => {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }

  // Atividade da biblioteca nas credenciais (leituras e gravações): usada no
  // encerramento para esperar ela "silenciar" antes de devolver a posse.
  let pending = 0
  let lastActivity = 0
  const touch = () => { lastActivity = Date.now() }
  const write = (items) => {
    pending++; touch()
    return serial(() => db.authWrite(companyId, items)).finally(() => { pending--; touch() })
  }
  const toItem = (category, keyId, value) => ({
    category, key_id: keyId, key_version: keyVersion,
    data: value == null ? null : pack(category, keyId, value).toString('base64'),
  })

  const credRows = await db.authRead(companyId, 'creds', ['creds'])
  const hadCreds = credRows.length > 0
  const creds = hadCreds ? unpack('creds', 'creds', credRows[0]) : initAuthCreds()

  return {
    hadCreds,
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          touch()
          const out = {}
          if (!ids.length) return out
          const rows = await db.authRead(companyId, type, ids)
          for (const row of rows) {
            let value = unpack(type, row.key_id, row)
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
            out[row.key_id] = value
          }
          return out
        },
        set: async (data) => {
          const items = []
          for (const category of Object.keys(data)) {
            for (const keyId of Object.keys(data[category] || {})) {
              items.push(toItem(category, keyId, data[category][keyId]))
            }
          }
          if (items.length) await write(items)
        },
      },
    },
    saveCreds: () => write([toItem('creds', 'creds', creds)]),
    flush: () => chain,
    // Espera não haver gravação em andamento e nenhuma atividade por quietMs
    // (a biblioteca costuma concluir gravações logo depois de fechar a conexão).
    // Limite: maxMs. Devolve true se silenciou, false se o tempo acabou.
    drain: async ({ quietMs = 500, maxMs = 3000 } = {}) => {
      const started = Date.now()
      const deadline = started + maxMs
      for (;;) {
        await chain
        // silêncio contado a partir do que vier por último: a última atividade
        // ou o INÍCIO da espera (gravações tardias só começam depois do fechamento)
        if (pending === 0 && Date.now() - Math.max(lastActivity, started) >= quietMs) return true
        if (Date.now() >= deadline) return false
        await new Promise((r) => setTimeout(r, Math.min(100, quietMs)))
      }
    },
  }
}
