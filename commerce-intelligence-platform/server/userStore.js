import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,100}$/
export const VIEWER_PERMISSIONS = Object.freeze(['overview', 'orders', 'journey', 'traffic', 'infra', 'sources', 'alerts'])
export const DEFAULT_VIEWER_PERMISSIONS = Object.freeze(['overview', 'orders', 'journey', 'traffic', 'infra'])
const VIEWER_PERMISSION_SET = new Set(VIEWER_PERMISSIONS)

export function validateManagedUsername(username) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username)
}

export function validateViewerPermissions(permissions) {
  return Array.isArray(permissions)
    && new Set(permissions).size === permissions.length
    && permissions.every((permission) => VIEWER_PERMISSION_SET.has(permission))
}

export function normalizeViewerPermissions(permissions) {
  if (!Array.isArray(permissions)) return [...DEFAULT_VIEWER_PERMISSIONS]
  return [...new Set(permissions.filter((permission) => VIEWER_PERMISSION_SET.has(permission)))]
}

function loadManagedUsers(strict = false) {
  try {
    if (!fs.existsSync(config.auth.managedUsersFile)) return []
    const parsed = JSON.parse(fs.readFileSync(config.auth.managedUsersFile, 'utf8'))
    if (!Array.isArray(parsed?.users)) return []
    return parsed.users
      .filter((user) => validateManagedUsername(user?.username) && user?.role === 'viewer' && typeof user?.passwordHash === 'string')
      .map((user) => ({ ...user, permissions: normalizeViewerPermissions(user.permissions) }))
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

export async function saveManagedViewer(username, passwordHash, permissions) {
  if (!validateManagedUsername(username)) throw new TypeError('Username must contain 3-100 letters, numbers, dots, underscores, or hyphens.')
  if (permissions !== undefined && !validateViewerPermissions(permissions)) throw new TypeError('Select valid viewer permissions.')
  const users = loadManagedUsers(true)
  const existingIndex = users.findIndex((user) => user.username === username)
  const savedPermissions = permissions ?? users[existingIndex]?.permissions ?? VIEWER_PERMISSIONS
  const next = { username, role: 'viewer', passwordHash, permissions: [...savedPermissions] }
  if (existingIndex >= 0) users[existingIndex] = next
  else users.push(next)
  await writeManagedUsers(users)
  return { username, role: 'viewer', permissions: next.permissions }
}

export async function updateManagedViewerPermissions(username, permissions) {
  if (!validateManagedUsername(username)) throw new TypeError('Invalid username.')
  if (!validateViewerPermissions(permissions)) throw new TypeError('Select valid viewer permissions.')
  const users = loadManagedUsers(true)
  const user = users.find((entry) => entry.username === username)
  if (!user) return false
  user.permissions = [...permissions]
  await writeManagedUsers(users)
  return true
}

export async function deleteManagedViewer(username) {
  const users = loadManagedUsers(true)
  const remaining = users.filter((user) => user.username !== username)
  if (remaining.length === users.length) return false
  await writeManagedUsers(remaining)
  return true
}
