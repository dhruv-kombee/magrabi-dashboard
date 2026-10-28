import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { initDatabase, isDatabaseConfigured, query } from './db.js'

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,100}$/
export const VIEWER_PERMISSIONS = Object.freeze(['overview', 'orders', 'journey', 'traffic', 'infra', 'sources', 'alerts'])
export const DEFAULT_VIEWER_PERMISSIONS = Object.freeze(['overview', 'orders', 'journey', 'traffic', 'infra'])
export const VALID_ROLES = Object.freeze(['admin', 'operations', 'analyst', 'viewer'])
const VIEWER_PERMISSION_SET = new Set(VIEWER_PERMISSIONS)

// In-memory cache for fast, synchronous access when database is configured
let dbUsersCache = null
let dbUsersCacheTime = 0
const DB_CACHE_TTL_MS = 10_000

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

// ---------------------------------------------------------------------------
// File-based Storage (Fallback when no DATABASE_URL is configured)
// ---------------------------------------------------------------------------

function loadManagedUsersFromFile(strict = false) {
  try {
    if (!fs.existsSync(config.auth.managedUsersFile)) return []
    const parsed = JSON.parse(fs.readFileSync(config.auth.managedUsersFile, 'utf8'))
    if (!Array.isArray(parsed?.users)) return []
    return parsed.users
      .filter((user) => validateManagedUsername(user?.username) && (user?.role === 'viewer' || VALID_ROLES.includes(user?.role)) && typeof user?.passwordHash === 'string')
      .map((user) => ({ ...user, permissions: normalizeViewerPermissions(user.permissions) }))
  } catch (error) {
    if (strict) throw new Error('Managed user storage is unavailable or invalid.', { cause: error })
    return []
  }
}

async function writeManagedUsersToFile(users) {
  const target = config.auth.managedUsersFile
  const directory = path.dirname(target)
  const temporary = `${target}.${process.pid}.tmp`
  await fsPromises.mkdir(directory, { recursive: true })
  await fsPromises.writeFile(temporary, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsPromises.rename(temporary, target)
  try { await fsPromises.chmod(target, 0o600) } catch { /* Windows permissions are inherited from the protected directory. */ }
}

// ---------------------------------------------------------------------------
// Database-backed Storage (Active when DATABASE_URL is provided)
// ---------------------------------------------------------------------------

async function fetchManagedUsersFromDb() {
  await initDatabase()
  const result = await query(
    'SELECT username, role, password_hash as "passwordHash", permissions FROM rbac_users WHERE is_active = TRUE ORDER BY created_at ASC'
  )
  const users = result.rows.map((row) => ({
    username: row.username,
    role: row.role || 'viewer',
    passwordHash: row.passwordHash,
    permissions: normalizeViewerPermissions(row.permissions),
  }))
  dbUsersCache = users
  dbUsersCacheTime = Date.now()
  return users
}

/**
 * Synchronous read of managed users:
 * 1. If database is configured and cache is fresh, returns cached database users.
 * 2. If database is not configured (or cache not ready), returns file-backed users.
 */
export function readManagedUsers({ strict = false } = {}) {
  if (isDatabaseConfigured() && dbUsersCache !== null && (Date.now() - dbUsersCacheTime < DB_CACHE_TTL_MS)) {
    return dbUsersCache
  }
  return loadManagedUsersFromFile(strict)
}

/**
 * Asynchronous read: authoritative query to the database when configured.
 */
export async function readManagedUsersAsync({ strict = false } = {}) {
  if (isDatabaseConfigured()) {
    try {
      return await fetchManagedUsersFromDb()
    } catch (error) {
      if (strict) throw new Error('Managed user database storage is unavailable.', { cause: error })
      return dbUsersCache || []
    }
  }
  return loadManagedUsersFromFile(strict)
}

/**
 * Creates or resets a managed user in the database (or file fallback).
 */
export async function saveManagedViewer(username, passwordHash, permissions, role = 'viewer') {
  if (!validateManagedUsername(username)) {
    throw new TypeError('Username must contain 3-100 letters, numbers, dots, underscores, or hyphens.')
  }
  if (permissions !== undefined && !validateViewerPermissions(permissions)) {
    throw new TypeError('Select valid viewer permissions.')
  }
  const assignedRole = VALID_ROLES.includes(role) ? role : 'viewer'

  if (isDatabaseConfigured()) {
    await initDatabase()
    const savedPermissions = permissions ?? VIEWER_PERMISSIONS
    await query(`
      INSERT INTO rbac_users (username, password_hash, role, permissions, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        permissions = EXCLUDED.permissions,
        updated_at = NOW();
    `, [username, passwordHash, assignedRole, [...savedPermissions]])

    await fetchManagedUsersFromDb()
    return { username, role: assignedRole, permissions: [...savedPermissions] }
  }

  // Fallback to file storage
  const users = loadManagedUsersFromFile(true)
  const existingIndex = users.findIndex((user) => user.username === username)
  const savedPermissions = permissions ?? users[existingIndex]?.permissions ?? VIEWER_PERMISSIONS
  const next = { username, role: assignedRole, passwordHash, permissions: [...savedPermissions] }
  if (existingIndex >= 0) users[existingIndex] = next
  else users.push(next)
  await writeManagedUsersToFile(users)
  return { username, role: assignedRole, permissions: next.permissions }
}

/**
 * Updates permissions for an existing managed user.
 */
export async function updateManagedViewerPermissions(username, permissions) {
  if (!validateManagedUsername(username)) throw new TypeError('Invalid username.')
  if (!validateViewerPermissions(permissions)) throw new TypeError('Select valid viewer permissions.')

  if (isDatabaseConfigured()) {
    await initDatabase()
    const result = await query(
      'UPDATE rbac_users SET permissions = $1, updated_at = NOW() WHERE username = $2 RETURNING username',
      [[...permissions], username]
    )
    if (result.rowCount === 0) return false
    await fetchManagedUsersFromDb()
    return true
  }

  const users = loadManagedUsersFromFile(true)
  const user = users.find((entry) => entry.username === username)
  if (!user) return false
  user.permissions = [...permissions]
  await writeManagedUsersToFile(users)
  return true
}

/**
 * Deletes a managed user.
 */
export async function deleteManagedViewer(username) {
  if (isDatabaseConfigured()) {
    await initDatabase()
    const result = await query('DELETE FROM rbac_users WHERE username = $1 RETURNING username', [username])
    if (result.rowCount === 0) return false
    await fetchManagedUsersFromDb()
    return true
  }

  const users = loadManagedUsersFromFile(true)
  const remaining = users.filter((user) => user.username !== username)
  if (remaining.length === users.length) return false
  await writeManagedUsersToFile(remaining)
  return true
}

/**
 * Records an entry in the RBAC audit log.
 */
export async function recordAuditLog(actorUsername, action, targetUsername, details = {}, ip = '') {
  if (!isDatabaseConfigured()) return
  try {
    await query(
      'INSERT INTO rbac_audit_logs (actor_username, action, target_username, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [actorUsername || 'system', action, targetUsername || null, JSON.stringify(details), ip || null]
    )
  } catch (err) {
    console.warn('[Audit Log Warning]:', err?.message)
  }
}
