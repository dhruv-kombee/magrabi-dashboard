import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { authenticateUser, authConfigurationStatus, createSessionToken, hashPassword, verifyPassword, verifySessionToken } from './auth.js'
import { DEFAULT_VIEWER_PERMISSIONS, saveManagedViewer, updateManagedViewerPermissions, VIEWER_PERMISSIONS } from './userStore.js'

let temporaryDirectory
const original = {
  adminUsername: process.env.AUTH_ADMIN_USERNAME,
  adminPasswordHash: process.env.AUTH_ADMIN_PASSWORD_HASH,
  viewerUsername: process.env.AUTH_VIEWER_USERNAME,
  viewerPasswordHash: process.env.AUTH_VIEWER_PASSWORD_HASH,
  sessionSecret: process.env.AUTH_SESSION_SECRET,
  timeout: process.env.AUTH_SESSION_TIMEOUT_MINUTES,
  managedUsersFile: process.env.AUTH_MANAGED_USERS_FILE,
}

test.before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'magrabi-auth-session-test-'))
  process.env.AUTH_ADMIN_USERNAME = 'security-test-admin'
  process.env.AUTH_ADMIN_PASSWORD_HASH = await hashPassword('unit-test-admin-password')
  process.env.AUTH_VIEWER_USERNAME = 'security-test-viewer'
  process.env.AUTH_VIEWER_PASSWORD_HASH = await hashPassword('unit-test-viewer-password')
  process.env.AUTH_SESSION_SECRET = 'unit-test-session-secret-with-more-than-32-characters'
  process.env.AUTH_SESSION_TIMEOUT_MINUTES = '10'
  process.env.AUTH_MANAGED_USERS_FILE = path.join(temporaryDirectory, 'users.json')
  await saveManagedViewer('permission-test-viewer', await hashPassword('unit-test-permission-viewer-password'), ['overview'])
})

test.after(async () => {
  for (const [key, value] of Object.entries({
    AUTH_ADMIN_USERNAME: original.adminUsername,
    AUTH_ADMIN_PASSWORD_HASH: original.adminPasswordHash,
    AUTH_VIEWER_USERNAME: original.viewerUsername,
    AUTH_VIEWER_PASSWORD_HASH: original.viewerPasswordHash,
    AUTH_SESSION_SECRET: original.sessionSecret,
    AUTH_SESSION_TIMEOUT_MINUTES: original.timeout,
    AUTH_MANAGED_USERS_FILE: original.managedUsersFile,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

test('authentication requires complete server-side configuration', () => {
  assert.deepEqual(authConfigurationStatus(), { configured: true, missing: [] })
})

test('scrypt password hash accepts the right password and rejects a wrong password', async () => {
  assert.equal(await verifyPassword('unit-test-admin-password'), true)
  assert.equal(await verifyPassword('incorrect-password'), false)
})

test('login assigns the role belonging to the supplied username', async () => {
  assert.deepEqual(await authenticateUser('security-test-admin', 'unit-test-admin-password'), { username: 'security-test-admin', role: 'admin', permissions: VIEWER_PERMISSIONS })
  assert.deepEqual(await authenticateUser('security-test-viewer', 'unit-test-viewer-password'), { username: 'security-test-viewer', role: 'viewer', permissions: DEFAULT_VIEWER_PERMISSIONS })
  assert.equal(await authenticateUser('security-test-viewer', 'unit-test-admin-password'), null)
})

test('signed session expires after ten minutes of inactivity', () => {
  const issuedAt = Date.parse('2026-10-26T10:00:00.000Z')
  const token = createSessionToken('security-test-viewer', 'viewer', issuedAt)
  assert.equal(verifySessionToken(token, issuedAt + 599_999)?.role, 'viewer')
  assert.deepEqual(verifySessionToken(token, issuedAt + 599_999)?.permissions, DEFAULT_VIEWER_PERMISSIONS)
  assert.equal(verifySessionToken(token, issuedAt + 600_000), null)
})

test('remember me keeps the session alive for thirty days', () => {
  const issuedAt = Date.parse('2026-10-26T10:00:00.000Z')
  const token = createSessionToken('security-test-viewer', 'viewer', issuedAt, { rememberMe: true })
  assert.equal(verifySessionToken(token, issuedAt + (30 * 24 * 60 * 60 * 1000) - 1)?.role, 'viewer')
  assert.equal(verifySessionToken(token, issuedAt + (30 * 24 * 60 * 60 * 1000)), null)
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

test('permission updates take effect on existing signed sessions', async () => {
  const issuedAt = Date.now()
  const token = createSessionToken('permission-test-viewer', 'viewer', issuedAt)
  assert.deepEqual(verifySessionToken(token, issuedAt + 1_000)?.permissions, ['overview'])
  await updateManagedViewerPermissions('permission-test-viewer', ['traffic'])
  assert.deepEqual(verifySessionToken(token, issuedAt + 2_000)?.permissions, ['traffic'])
})
