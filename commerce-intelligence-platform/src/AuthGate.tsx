import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { SectionKey } from './types'
import styles from './AuthGate.module.css'

type Session = {
  authenticated: true
  username: string
  role: 'admin' | 'viewer'
  permissions: SectionKey[]
  expiresAt: number
  timeoutSeconds: number
}

const REMEMBERED_USERNAME_KEY = 'magrabi_ci_last_username'

type AuthResponse = Partial<Session> & { authenticated?: boolean; error?: string; missing?: string[] }

async function authRequest(path: string, options?: RequestInit): Promise<AuthResponse> {
  const response = await fetch(`/api/commerce/auth/${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  const payload = await response.json().catch(() => ({})) as AuthResponse
  if (!response.ok) throw Object.assign(new Error(payload.error || 'Authentication request failed.'), { status: response.status, payload })
  return payload
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [username, setUsername] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(REMEMBERED_USERNAME_KEY) || ''
  })
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(() => {
    if (typeof window === 'undefined') return false
    return Boolean(window.localStorage.getItem(REMEMBERED_USERNAME_KEY))
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const storedUsername = window.localStorage.getItem(REMEMBERED_USERNAME_KEY)
    if (storedUsername) {
      setUsername(storedUsername)
      setRememberMe(true)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (rememberMe && username.trim()) window.localStorage.setItem(REMEMBERED_USERNAME_KEY, username.trim())
    else window.localStorage.removeItem(REMEMBERED_USERNAME_KEY)
  }, [rememberMe, username])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await authRequest('login', { method: 'POST', body: JSON.stringify({ username, password, rememberMe }) })
      if (result.authenticated && result.username && result.role && Array.isArray(result.permissions) && result.expiresAt && result.timeoutSeconds) {
        if (rememberMe) window.localStorage.setItem(REMEMBERED_USERNAME_KEY, result.username)
        else window.localStorage.removeItem(REMEMBERED_USERNAME_KEY)
        onAuthenticated(result as Session)
      } else setError('Sign-in could not be completed.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in could not be completed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginCard} aria-labelledby="login-title">
        <div className={styles.brandMark} aria-hidden="true">M</div>
        <p className={styles.eyebrow}>MAGRABI</p>
        <h1 id="login-title">Commerce Intelligence</h1>
        <p className={styles.intro}>Sign in to access operational dashboards and read-only commerce insights.</p>
        <form onSubmit={submit} className={styles.form}>
          <label htmlFor="auth-username">Username</label>
          <input
            id="auth-username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            autoFocus
          />
          <label htmlFor="auth-password">Password</label>
          <div className={styles.passwordField}>
            <input
              id="auth-password"
              className={styles.passwordInput}
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button
              className={styles.passwordToggle}
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 4.3A10.8 10.8 0 0112 4c5 0 8.5 4.2 9.5 6.5a3.7 3.7 0 010 3M6.6 6.6C4.5 8 3.1 10 2.5 11.5a1.3 1.3 0 000 1C3.5 14.8 7 19 12 19c1.5 0 2.9-.4 4.1-1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.5 11.5C3.5 9.2 7 5 12 5s8.5 4.2 9.5 6.5a1.3 1.3 0 010 1C20.5 14.8 17 19 12 19s-8.5-4.2-9.5-6.5a1.3 1.3 0 010-1z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
              <span>{showPassword ? 'Hide' : 'Show'}</span>
            </button>
          </div>
          <label className={styles.rememberRow} htmlFor="auth-remember-me">
            <input
              id="auth-remember-me"
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
            />
            <span>Remember me</span>
          </label>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className={styles.submitButton} type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className={styles.sessionNote}>{rememberMe ? 'This device stays signed in for 30 days.' : 'For your security, inactive sessions close after 10 minutes.'}</p>
      </section>
    </main>
  )
}

export function AuthGate({ children }: { children: (session: Session, onLogout: () => Promise<void>) => ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [configurationError, setConfigurationError] = useState('')
  const sessionRef = useRef<Session | null>(null)
  const lastActivityRequest = useRef(0)
  const activityInFlight = useRef(false)
  const activityRequest = useRef<Promise<void> | null>(null)
  const loggingOut = useRef(false)

  const updateSession = useCallback((next: Session | null) => {
    sessionRef.current = next
    setSession(next)
  }, [])

  useEffect(() => {
    authRequest('session')
      .then((result) => {
        if (result.authenticated && result.username && result.role && Array.isArray(result.permissions) && result.expiresAt && result.timeoutSeconds) updateSession(result as Session)
      })
      .catch((cause: Error & { status?: number; payload?: AuthResponse }) => {
        if (cause.status === 503) setConfigurationError(cause.message)
      })
      .finally(() => setChecking(false))
  }, [updateSession])

  useEffect(() => {
    if (!session) return
    const remaining = Math.max(0, session.expiresAt - Date.now())
    // Browsers clamp setTimeout to a 32-bit signed integer (max ~24.8 days).
    // Values exceeding 2,147,483,647 ms overflow to 1 ms and fire immediately!
    const MAX_TIMEOUT_MS = 2_147_483_647
    const delay = Math.min(remaining + 100, MAX_TIMEOUT_MS)
    const timer = window.setTimeout(() => {
      if (Date.now() >= session.expiresAt) {
        updateSession(null)
      }
    }, delay)
    return () => window.clearTimeout(timer)
  }, [session, updateSession])

  useEffect(() => {
    if (!session) return
    const recordActivity = (event: Event) => {
      if (loggingOut.current || (event.target instanceof Element && event.target.closest('[data-auth-logout]'))) return
      const current = sessionRef.current
      const now = Date.now()
      if (!current || activityInFlight.current || now - lastActivityRequest.current < 30_000) return
      if (now >= current.expiresAt) { updateSession(null); return }
      lastActivityRequest.current = now
      activityInFlight.current = true
      activityRequest.current = (async () => {
        try {
          const result = await authRequest('activity', { method: 'POST', body: '{}' })
          if (!loggingOut.current && result.authenticated && result.username && result.role && Array.isArray(result.permissions) && result.expiresAt && result.timeoutSeconds) updateSession(result as Session)
        } catch (cause) {
          if (!loggingOut.current && (cause as { status?: number }).status === 401) updateSession(null)
        } finally {
          activityInFlight.current = false
          activityRequest.current = null
        }
      })()
    }
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'scroll']
    events.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }))
    return () => events.forEach((eventName) => window.removeEventListener(eventName, recordActivity))
  }, [session, updateSession])

  const logout = async () => {
    loggingOut.current = true
    updateSession(null)
    try { await activityRequest.current } catch { /* The logout request below remains authoritative. */ }
    try { await authRequest('logout', { method: 'POST', body: '{}' }) } catch { /* Clear the local session even if the request fails. */ }
  }

  if (checking) return <main className={styles.loadingPage}><div className={styles.spinner} aria-label="Checking session" /></main>
  if (!session) {
    return (
      <>
        {configurationError && <div className={styles.configurationError} role="alert">{configurationError} Contact the platform administrator.</div>}
        <LoginScreen onAuthenticated={(next) => { loggingOut.current = false; setConfigurationError(''); lastActivityRequest.current = Date.now(); updateSession(next) }} />
      </>
    )
  }

  return (
    <div className={styles.authenticatedShell}>
      {children(session, logout)}
    </div>
  )
}
