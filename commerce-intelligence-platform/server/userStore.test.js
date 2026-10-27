import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  deleteManagedViewer,
  DEFAULT_VIEWER_PERMISSIONS,
  readManagedUsers,
  saveManagedViewer,
  updateManagedViewerPermissions,
  validateManagedUsername,
  validateViewerPermissions,
  VIEWER_PERMISSIONS,
} from './userStore.js'

let temporaryDirectory
let originalUsersFile

test.before(async () => {
  originalUsersFile = process.env.AUTH_MANAGED_USERS_FILE
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'magrabi-auth-test-'))
  process.env.AUTH_MANAGED_USERS_FILE = path.join(temporaryDirectory, 'users.json')
})

test.after(async () => {
  if (originalUsersFile === undefined) delete process.env.AUTH_MANAGED_USERS_FILE
  else process.env.AUTH_MANAGED_USERS_FILE = originalUsersFile
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

test('managed viewer records can be created, reset, and deleted without plaintext passwords', async () => {
  await saveManagedViewer('store_viewer', 'scrypt$first-hash')
  assert.deepEqual(readManagedUsers(), [{ username: 'store_viewer', role: 'viewer', passwordHash: 'scrypt$first-hash', permissions: VIEWER_PERMISSIONS }])
  await saveManagedViewer('store_viewer', 'scrypt$replacement-hash')
  assert.equal(readManagedUsers()[0].passwordHash, 'scrypt$replacement-hash')
  assert.deepEqual(readManagedUsers()[0].permissions, VIEWER_PERMISSIONS)
  await updateManagedViewerPermissions('store_viewer', ['traffic'])
  assert.deepEqual(readManagedUsers()[0].permissions, ['traffic'])
  await saveManagedViewer('store_viewer', 'scrypt$second-reset-hash')
  assert.deepEqual(readManagedUsers()[0].permissions, ['traffic'])
  assert.equal(await deleteManagedViewer('store_viewer'), true)
  assert.deepEqual(readManagedUsers(), [])
})

test('viewer permissions accept only unique dashboard module keys', async () => {
  assert.equal(validateViewerPermissions(['overview', 'traffic']), true)
  assert.equal(validateViewerPermissions([]), true)
  assert.equal(validateViewerPermissions(['users']), false)
  assert.equal(validateViewerPermissions(['traffic', 'traffic']), false)
  await saveManagedViewer('permission_viewer', 'scrypt$first-hash', ['traffic'])
  await assert.rejects(updateManagedViewerPermissions('permission_viewer', ['unknown']), TypeError)
  assert.deepEqual(readManagedUsers().find((user) => user.username === 'permission_viewer')?.permissions, ['traffic'])
})

test('legacy viewer records keep their previous module access', async () => {
  const usersFile = path.join(temporaryDirectory, 'users.json')
  await fs.writeFile(usersFile, JSON.stringify({
    version: 1,
    users: [{ username: 'legacy_viewer', role: 'viewer', passwordHash: 'scrypt$legacy-hash' }],
  }))
  assert.deepEqual(readManagedUsers(), [{
    username: 'legacy_viewer',
    role: 'viewer',
    passwordHash: 'scrypt$legacy-hash',
    permissions: DEFAULT_VIEWER_PERMISSIONS,
  }])
  await saveManagedViewer('legacy_viewer', 'scrypt$reset-hash')
  assert.deepEqual(readManagedUsers()[0].permissions, DEFAULT_VIEWER_PERMISSIONS)
})

test('managed usernames accept only a bounded safe character set', () => {
  assert.equal(validateManagedUsername('viewer_2026'), true)
  assert.equal(validateManagedUsername('../viewer'), false)
  assert.equal(validateManagedUsername('ab'), false)
})
