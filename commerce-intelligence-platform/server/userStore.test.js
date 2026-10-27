import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deleteManagedViewer, readManagedUsers, saveManagedViewer, validateManagedUsername } from './userStore.js'

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
  assert.deepEqual(readManagedUsers(), [{ username: 'store_viewer', role: 'viewer', passwordHash: 'scrypt$first-hash' }])
  await saveManagedViewer('store_viewer', 'scrypt$replacement-hash')
  assert.equal(readManagedUsers()[0].passwordHash, 'scrypt$replacement-hash')
  assert.equal(await deleteManagedViewer('store_viewer'), true)
  assert.deepEqual(readManagedUsers(), [])
})

test('managed usernames accept only a bounded safe character set', () => {
  assert.equal(validateManagedUsername('viewer_2026'), true)
  assert.equal(validateManagedUsername('../viewer'), false)
  assert.equal(validateManagedUsername('ab'), false)
})
