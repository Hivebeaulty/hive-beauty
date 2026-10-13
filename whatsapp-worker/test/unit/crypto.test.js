import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { aadFor, companyKey, decrypt, encrypt, loadMasterKey } from '../../src/crypto.js'

const master = randomBytes(32)
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

test('ida e volta; o cifrado não contém o texto original e tem >= 29 bytes', () => {
  const k = companyKey(master, A)
  const plain = Buffer.from('{"segredo":"credencial-do-whatsapp"}')
  const blob = encrypt(k, plain, aadFor(A, 'creds', 'creds'))
  assert.ok(blob.length >= 29)
  assert.ok(!blob.includes(Buffer.from('credencial')))
  assert.deepEqual(decrypt(k, blob, aadFor(A, 'creds', 'creds')), plain)
})

test('mesmo texto cifrado duas vezes gera resultados diferentes (nonce aleatório)', () => {
  const k = companyKey(master, A)
  const a = encrypt(k, Buffer.from('x'), aadFor(A, 'c', 'k'))
  const b = encrypt(k, Buffer.from('x'), aadFor(A, 'c', 'k'))
  assert.notDeepEqual(a, b)
})

test('qualquer byte alterado é detectado', () => {
  const k = companyKey(master, A)
  const blob = encrypt(k, Buffer.from('dado'), aadFor(A, 'c', 'k'))
  for (const i of [0, 5, 20, blob.length - 1]) {
    const t = Buffer.from(blob); t[i] ^= 0x01
    assert.throws(() => decrypt(k, t, aadFor(A, 'c', 'k')))
  }
})

test('chave de OUTRA empresa não abre (isolamento por company_id)', () => {
  const blob = encrypt(companyKey(master, A), Buffer.from('dado'), aadFor(A, 'c', 'k'))
  assert.throws(() => decrypt(companyKey(master, B), blob, aadFor(A, 'c', 'k')))
})

test('linha trocada de lugar (outra categoria/id/empresa) não abre', () => {
  const k = companyKey(master, A)
  const blob = encrypt(k, Buffer.from('dado'), aadFor(A, 'session', 'x'))
  assert.throws(() => decrypt(k, blob, aadFor(A, 'session', 'y')))
  assert.throws(() => decrypt(k, blob, aadFor(A, 'pre-key', 'x')))
  assert.throws(() => decrypt(k, blob, aadFor(B, 'session', 'x')))
})

test('chave-mestra errada ou versão de chave diferente não abre', () => {
  const blob = encrypt(companyKey(master, A, 1), Buffer.from('dado'), aadFor(A, 'c', 'k'))
  assert.throws(() => decrypt(companyKey(randomBytes(32), A, 1), blob, aadFor(A, 'c', 'k')))
  assert.throws(() => decrypt(companyKey(master, A, 2), blob, aadFor(A, 'c', 'k')))
})

test('chave-mestra precisa ter 32 bytes', () => {
  assert.throws(() => loadMasterKey(randomBytes(16).toString('base64')))
  assert.throws(() => loadMasterKey(''))
  assert.equal(loadMasterKey(randomBytes(32).toString('base64')).length, 32)
})
