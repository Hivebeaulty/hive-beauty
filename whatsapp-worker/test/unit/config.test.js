import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readConfig } from '../../src/config.js'

const ok = { DATABASE_URL: 'postgres://x', WA_MASTER_KEY: 'a', DB_SSL_CA_FILE: '/tmp/ca.pem' }
test('falta DATABASE_URL ou WA_MASTER_KEY: não inicia', () => {
  assert.throws(() => readConfig({ WA_MASTER_KEY: 'a' }), /DATABASE_URL/)
  assert.throws(() => readConfig({ DATABASE_URL: 'x' }), /WA_MASTER_KEY/)
})
test('provedor falso é proibido fora de teste', () => {
  assert.throws(() => readConfig({ ...ok, WA_PROVIDER: 'fake' }), /NODE_ENV=test/)
  assert.equal(readConfig({ ...ok, WA_PROVIDER: 'fake', NODE_ENV: 'test' }).provider, 'fake')
  assert.equal(readConfig(ok).provider, 'baileys')
})
test('limites numéricos validados', () => {
  assert.throws(() => readConfig({ ...ok, LEASE_TTL_SECONDS: '5' }))
  assert.equal(readConfig(ok).leaseTtlSec, 60)
})

test('banco: SSL com certificado verificado é obrigatório fora de teste', () => {
  assert.throws(() => readConfig({ DATABASE_URL: 'x', WA_MASTER_KEY: 'a' }), /DB_SSL_CA_FILE/)
  assert.throws(() => readConfig({ ...ok, DB_SSL: 'off' }), /NODE_ENV=test/)
  assert.equal(readConfig({ ...ok, DB_SSL: 'off', NODE_ENV: 'test' }).dbSsl, 'off')
  assert.equal(readConfig(ok).dbSsl, 'verify')
})

test('grupos, transmissões e canais ficam fora por padrão; WA_IGNORE_GROUPS=false liga de volta', () => {
  assert.equal(readConfig(ok).ignoreGroups, true)
  assert.equal(readConfig({ ...ok, WA_IGNORE_GROUPS: 'false' }).ignoreGroups, false)
})
