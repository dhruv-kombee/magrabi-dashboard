import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import styles from './AuthGate.module.css'

type Session = {
  authenticated: true
  username: string
  expiresAt: number
  timeoutSeconds: number
}

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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await authRequest('login', { method: 'POST', body: JSON.stringify({ username, password }) })
      if (result.authenticated && result.username && result.expiresAt && result.timeoutSeconds) onAuthenticated(result as Session)
      else setError('Sign-in could not be completed.')
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
          <input
            id="auth-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className={styles.sessionNote}>For your security, inactive sessions close after 10 minutes.</p>
      </section>
    </main>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
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
        if (result.authenticated && result.username && result.expiresAt && result.timeoutSeconds) updateSession(result as Session)
      })
      .catch((cause: Error & { status?: number; payload?: AuthResponse }) => {
        if (cause.status === 503) setConfigurationError(cause.message)
      })
      .finally(() => setChecking(false))
  }, [updateSession])

  useEffect(() => {
    if (!session) return
    const remaining = Math.max(0, session.expiresAt - Date.now())
    const timer = window.setTimeout(() => updateSession(null), remaining + 100)
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
          if (!loggingOut.current && result.authenticated && result.username && result.expiresAt && result.timeoutSeconds) updateSession(result as Session)
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
      <button data-auth-logout className={styles.logoutButton} type="button" onClick={logout} aria-label={`Sign out ${session.username}`}>
        <span className={styles.userDot} aria-hidden="true" />
        <span className={styles.logoutLabel}>{session.username}</span>
        <span>Sign out</span>
      </button>
      {children}
    </div>
  )
}
