import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.js'
import { readManagedUsers } from './userStore.js'

const scrypt = promisify(scryptCallback)
const COOKIE_NAME = 'magrabi_ci_session'
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 5
const loginAttempts = new Map()

const encode = (value) => Buffer.from(value).toString('base64url')
const decode = (value) => Buffer.from(value, 'base64url').toString('utf8')

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function authConfigurationStatus() {
  const configured = Boolean(config.auth.adminUsername && config.auth.adminPasswordHash && config.auth.sessionSecret)
  const validSecret = Buffer.byteLength(config.auth.sessionSecret || '', 'utf8') >= 32
  return {
    configured: configured && validSecret,
    missing: [
      !config.auth.adminUsername && 'AUTH_ADMIN_USERNAME',
      !config.auth.adminPasswordHash && 'AUTH_ADMIN_PASSWORD_HASH',
      !config.auth.sessionSecret && 'AUTH_SESSION_SECRET',
      config.auth.sessionSecret && !validSecret && 'AUTH_SESSION_SECRET (minimum 32 characters)',
    ].filter(Boolean),
  }
}

export async function hashPassword(password, salt = randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Password must contain at least 12 characters.')
  const derived = await scrypt(password, salt, 64)
  return `scrypt$${Buffer.from(salt).toString('base64url')}$${Buffer.from(derived).toString('base64url')}`
}

export async function verifyPassword(password, storedHash = config.auth.adminPasswordHash) {
  try {
    const [algorithm, saltValue, hashValue] = String(storedHash).split('$')
    if (algorithm !== 'scrypt' || !saltValue || !hashValue || typeof password !== 'string') return false
    const expected = Buffer.from(hashValue, 'base64url')
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function sign(payload, secret = config.auth.sessionSecret) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

const credentialVersion = (passwordHash) => createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16)

export function configuredUsers() {
  const environmentUsers = [
    { username: config.auth.adminUsername, passwordHash: config.auth.adminPasswordHash, role: 'admin' },
    { username: config.auth.viewerUsername, passwordHash: config.auth.viewerPasswordHash, role: 'viewer' },
  ].filter((user) => user.username && user.passwordHash)
  const reserved = new Set(environmentUsers.map((user) => user.username))
  return [...environmentUsers, ...readManagedUsers().filter((user) => !reserved.has(user.username))]
}

export async function authenticateUser(username, password) {
  const user = configuredUsers().find((candidate) => candidate.username === username)
  if (!user || !await verifyPassword(password, user.passwordHash)) return null
  return { username: user.username, role: user.role }
}

export function createSessionToken(username = config.auth.adminUsername, role = 'admin', now = Date.now()) {
  const user = configuredUsers().find((candidate) => candidate.username === username && candidate.role === role)
  const payload = encode(JSON.stringify({ username, role, credentialVersion: user ? credentialVersion(user.passwordHash) : '', issuedAt: now, lastActivityAt: now, nonce: randomBytes(16).toString('base64url') }))
  return `${payload}.${sign(payload)}`
}

export function verifySessionToken(token, now = Date.now()) {
  try {
    const [payload, signature, extra] = String(token || '').split('.')
    if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return null
    const session = JSON.parse(decode(payload))
    const timeoutMs = config.auth.sessionTimeoutSeconds * 1000
    const configuredUser = configuredUsers().find((user) => user.username === session.username && user.role === session.role && credentialVersion(user.passwordHash) === session.credentialVersion)
    if (!configuredUser || !Number.isFinite(session.lastActivityAt)) return null
    if (session.lastActivityAt > now + 30_000 || now - session.lastActivityAt >= timeoutMs) return null
    return { ...session, expiresAt: session.lastActivityAt + timeoutMs }
  } catch {
    return null
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=')
    return separator < 0 ? [part, ''] : [part.slice(0, separator), part.slice(separator + 1)]
  }))
}

export function getRequestSession(req, now = Date.now()) {
  return verifySessionToken(parseCookies(req.headers?.cookie)[COOKIE_NAME], now)
}

function isHttps(req) {
  return Boolean(req.socket?.encrypted) || String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https'
}

export function setSessionCookie(req, res, token, maxAge = config.auth.sessionTimeoutSeconds) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.max(0, Math.floor(maxAge))}`]
  if (isHttps(req)) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function clearSessionCookie(req, res) {
  setSessionCookie(req, res, '', 0)
}

export function refreshSession(req, res, session, now = Date.now()) {
  const payload = encode(JSON.stringify({ username: session.username, role: session.role, credentialVersion: session.credentialVersion, issuedAt: session.issuedAt, lastActivityAt: now, nonce: randomBytes(16).toString('base64url') }))
  setSessionCookie(req, res, `${payload}.${sign(payload)}`)
  return { ...session, lastActivityAt: now, expiresAt: now + config.auth.sessionTimeoutSeconds * 1000 }
}

function clientKey(req) {
  return req.socket?.remoteAddress || 'unknown'
}

export function loginRateLimit(req, now = Date.now()) {
  const key = clientKey(req)
  const recent = (loginAttempts.get(key) || []).filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS)
  if (recent.length >= MAX_LOGIN_ATTEMPTS) {
    loginAttempts.set(key, recent)
    return { allowed: false, retryAfterSeconds: Math.ceil((LOGIN_WINDOW_MS - (now - recent[0])) / 1000) }
  }
  return { allowed: true, recordFailure: () => loginAttempts.set(key, [...recent, now]), clear: () => loginAttempts.delete(key) }
}
