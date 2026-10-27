import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,100}$/

export function validateManagedUsername(username) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username)
}

function loadManagedUsers(strict = false) {
  try {
    if (!fs.existsSync(config.auth.managedUsersFile)) return []
    const parsed = JSON.parse(fs.readFileSync(config.auth.managedUsersFile, 'utf8'))
    if (!Array.isArray(parsed?.users)) return []
    return parsed.users.filter((user) => validateManagedUsername(user?.username) && user?.role === 'viewer' && typeof user?.passwordHash === 'string')
  } catch (error) {
    if (strict) throw new Error('Managed user storage is unavailable or invalid.', { cause: error })
    return []
  }
}

export function readManagedUsers({ strict = false } = {}) {
  return loadManagedUsers(strict)
}

async function writeManagedUsers(users) {
  const target = config.auth.managedUsersFile
  const directory = path.dirname(target)
  const temporary = `${target}.${process.pid}.tmp`
  await fsPromises.mkdir(directory, { recursive: true })
  await fsPromises.writeFile(temporary, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsPromises.rename(temporary, target)
  try { await fsPromises.chmod(target, 0o600) } catch { /* Windows permissions are inherited from the protected directory. */ }
}

export async function saveManagedViewer(username, passwordHash) {
  if (!validateManagedUsername(username)) throw new TypeError('Username must contain 3-100 letters, numbers, dots, underscores, or hyphens.')
  const users = loadManagedUsers(true)
  const existingIndex = users.findIndex((user) => user.username === username)
  const next = { username, role: 'viewer', passwordHash }
  if (existingIndex >= 0) users[existingIndex] = next
  else users.push(next)
  await writeManagedUsers(users)
  return { username, role: 'viewer' }
}

export async function deleteManagedViewer(username) {
  const users = loadManagedUsers(true)
  const remaining = users.filter((user) => user.username !== username)
  if (remaining.length === users.length) return false
  await writeManagedUsers(remaining)
  return true
}
