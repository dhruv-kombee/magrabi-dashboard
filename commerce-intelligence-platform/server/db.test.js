import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from './config.js'
import { isDatabaseConfigured, getPool, closePool } from './db.js'
import { VALID_ROLES } from './userStore.js'

test('database configuration detects DATABASE_URL and SSL requirements', () => {
  const originalDbUrl = process.env.DATABASE_URL
  const originalAuthDbUrl = process.env.AUTH_DATABASE_URL
  const originalSsl = process.env.DATABASE_SSL

  try {
    delete process.env.DATABASE_URL
    delete process.env.AUTH_DATABASE_URL
    delete process.env.DATABASE_SSL

    assert.equal(config.database.isConfigured, false)
    assert.equal(isDatabaseConfigured(), false)
    assert.equal(getPool(), null)

    process.env.DATABASE_URL = 'postgres://testuser:testpass@dpg-abc123-a.oregon-postgres.render.com/commerce_db'
    assert.equal(config.database.isConfigured, true)
    assert.equal(isDatabaseConfigured(), true)
    assert.deepEqual(config.database.ssl, { rejectUnauthorized: false })

    process.env.DATABASE_SSL = 'false'
    assert.equal(config.database.ssl, false)

    process.env.DATABASE_SSL = 'true'
    assert.deepEqual(config.database.ssl, { rejectUnauthorized: false })
  } finally {
    if (originalDbUrl !== undefined) process.env.DATABASE_URL = originalDbUrl
    else delete process.env.DATABASE_URL
    if (originalAuthDbUrl !== undefined) process.env.AUTH_DATABASE_URL = originalAuthDbUrl
    else delete process.env.AUTH_DATABASE_URL
    if (originalSsl !== undefined) process.env.DATABASE_SSL = originalSsl
    else delete process.env.DATABASE_SSL
    closePool()
  }
})

test('valid roles list includes admin, operations, analyst, and viewer', () => {
  assert.ok(VALID_ROLES.includes('admin'))
  assert.ok(VALID_ROLES.includes('operations'))
  assert.ok(VALID_ROLES.includes('analyst'))
  assert.ok(VALID_ROLES.includes('viewer'))
})
