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

  const write = (items) => serial(() => db.authWrite(companyId, items))
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
  }
}
