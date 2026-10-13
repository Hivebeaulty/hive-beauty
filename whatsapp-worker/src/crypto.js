// Credenciais do WhatsApp cifradas com AES-256-GCM ANTES de ir para o banco.
//  - Chave-mestra: 32 bytes em base64, só no ambiente do worker (WA_MASTER_KEY).
//  - Cada empresa (e cada versão de chave) tem chave própria: HKDF-SHA256.
//  - O "lugar" do dado (empresa|categoria|id) entra como AAD: uma linha copiada
//    para outro lugar ou outra empresa não abre.
// Formato: [versão do formato = 1][nonce 12][dado cifrado][tag 16]  (>= 30 bytes)
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const FORMAT = 1
const SALT = Buffer.from('aurea-wa-auth')

export function loadMasterKey(b64) {
  const key = Buffer.from(String(b64 || ''), 'base64')
  if (key.length !== 32) throw new Error('WA_MASTER_KEY precisa ter exatamente 32 bytes em base64.')
  return key
}

export function companyKey(master, companyId, version = 1) {
  return Buffer.from(hkdfSync('sha256', master, SALT, Buffer.from(`${companyId}|v${version}`), 32))
}

export function aadFor(companyId, category, keyId) {
  return Buffer.from(`${companyId}|${category}|${keyId}`)
}

export function encrypt(key, plaintext, aad) {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(Buffer.concat([Buffer.from([FORMAT]), aad]))   // o byte de formato também é protegido
  const body = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([Buffer.from([FORMAT]), nonce, body, c.getAuthTag()])
}

export function decrypt(key, blob, aad) {
  const b = Buffer.from(blob)
  if (b.length < 30 || b[0] !== FORMAT) throw new Error('Credencial em formato desconhecido.')
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(1, 13))
  d.setAAD(Buffer.concat([Buffer.from([FORMAT]), aad]))
  d.setAuthTag(b.subarray(b.length - 16))
  return Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()])   // lança se algo não bater
}
