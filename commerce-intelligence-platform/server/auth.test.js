import test from 'node:test'
import assert from 'node:assert/strict'
import { authConfigurationStatus, createSessionToken, hashPassword, verifyPassword, verifySessionToken } from './auth.js'

const original = {
  username: process.env.AUTH_USERNAME,
  passwordHash: process.env.AUTH_PASSWORD_HASH,
  sessionSecret: process.env.AUTH_SESSION_SECRET,
  timeout: process.env.AUTH_SESSION_TIMEOUT_MINUTES,
}

test.before(async () => {
  process.env.AUTH_USERNAME = 'security-test-user'
  process.env.AUTH_PASSWORD_HASH = await hashPassword('unit-test-password-only')
  process.env.AUTH_SESSION_SECRET = 'unit-test-session-secret-with-more-than-32-characters'
  process.env.AUTH_SESSION_TIMEOUT_MINUTES = '10'
})

test.after(() => {
  for (const [key, value] of Object.entries({
    AUTH_USERNAME: original.username,
    AUTH_PASSWORD_HASH: original.passwordHash,
    AUTH_SESSION_SECRET: original.sessionSecret,
    AUTH_SESSION_TIMEOUT_MINUTES: original.timeout,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('authentication requires complete server-side configuration', () => {
  assert.deepEqual(authConfigurationStatus(), { configured: true, missing: [] })
})

test('scrypt password hash accepts the right password and rejects a wrong password', async () => {
  assert.equal(await verifyPassword('unit-test-password-only'), true)
  assert.equal(await verifyPassword('incorrect-password'), false)
})

test('signed session expires after ten minutes of inactivity', () => {
  const issuedAt = Date.parse('2026-10-26T10:00:00.000Z')
  const token = createSessionToken('security-test-user', issuedAt)
  assert.equal(verifySessionToken(token, issuedAt + 599_999)?.username, 'security-test-user')
  assert.equal(verifySessionToken(token, issuedAt + 600_000), null)
})

test('tampered session token is rejected', () => {
  const token = createSessionToken('security-test-user', Date.now())
  const [payload, signature] = token.split('.')
  assert.equal(verifySessionToken(`${payload}.${signature.slice(0, -1)}x`), null)
})
