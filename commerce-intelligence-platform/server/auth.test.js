import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateUser, authConfigurationStatus, createSessionToken, hashPassword, verifyPassword, verifySessionToken } from './auth.js'

const original = {
  adminUsername: process.env.AUTH_ADMIN_USERNAME,
  adminPasswordHash: process.env.AUTH_ADMIN_PASSWORD_HASH,
  viewerUsername: process.env.AUTH_VIEWER_USERNAME,
  viewerPasswordHash: process.env.AUTH_VIEWER_PASSWORD_HASH,
  sessionSecret: process.env.AUTH_SESSION_SECRET,
  timeout: process.env.AUTH_SESSION_TIMEOUT_MINUTES,
}

test.before(async () => {
  process.env.AUTH_ADMIN_USERNAME = 'security-test-admin'
  process.env.AUTH_ADMIN_PASSWORD_HASH = await hashPassword('unit-test-admin-password')
  process.env.AUTH_VIEWER_USERNAME = 'security-test-viewer'
  process.env.AUTH_VIEWER_PASSWORD_HASH = await hashPassword('unit-test-viewer-password')
  process.env.AUTH_SESSION_SECRET = 'unit-test-session-secret-with-more-than-32-characters'
  process.env.AUTH_SESSION_TIMEOUT_MINUTES = '10'
})

test.after(() => {
  for (const [key, value] of Object.entries({
    AUTH_ADMIN_USERNAME: original.adminUsername,
    AUTH_ADMIN_PASSWORD_HASH: original.adminPasswordHash,
    AUTH_VIEWER_USERNAME: original.viewerUsername,
    AUTH_VIEWER_PASSWORD_HASH: original.viewerPasswordHash,
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
  assert.equal(await verifyPassword('unit-test-admin-password'), true)
  assert.equal(await verifyPassword('incorrect-password'), false)
})

test('login assigns the role belonging to the supplied username', async () => {
  assert.deepEqual(await authenticateUser('security-test-admin', 'unit-test-admin-password'), { username: 'security-test-admin', role: 'admin' })
  assert.deepEqual(await authenticateUser('security-test-viewer', 'unit-test-viewer-password'), { username: 'security-test-viewer', role: 'viewer' })
  assert.equal(await authenticateUser('security-test-viewer', 'unit-test-admin-password'), null)
})

test('signed session expires after ten minutes of inactivity', () => {
  const issuedAt = Date.parse('2026-10-26T10:00:00.000Z')
  const token = createSessionToken('security-test-viewer', 'viewer', issuedAt)
  assert.equal(verifySessionToken(token, issuedAt + 599_999)?.role, 'viewer')
  assert.equal(verifySessionToken(token, issuedAt + 600_000), null)
})

test('tampered session token is rejected', () => {
  const token = createSessionToken('security-test-admin', 'admin', Date.now())
  const [payload, signature] = token.split('.')
  assert.equal(verifySessionToken(`${payload}.${signature.slice(0, -1)}x`), null)
})

test('changing a user password invalidates sessions signed for the previous credential', async () => {
  const issuedAt = Date.now()
  const token = createSessionToken('security-test-viewer', 'viewer', issuedAt)
  process.env.AUTH_VIEWER_PASSWORD_HASH = await hashPassword('replacement-viewer-password')
  assert.equal(verifySessionToken(token, issuedAt + 1_000), null)
})
