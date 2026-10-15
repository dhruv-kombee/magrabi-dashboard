import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLoginMutation } from '../api/hooks'
import logoUrl from '../assets/magrabi-logo.svg'
import styles from './LoginPage.module.css'

export function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const login = useLoginMutation()
  const navigate = useNavigate()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    login.mutate(
      { username, password },
      {
        onSuccess: (data) => {
          if (data.ok) navigate(data.role === 'admin' ? '/admin' : '/status', { replace: true })
        },
      },
    )
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <img src={logoUrl} alt="Magrabi" className={styles.logo} />
        <p className={styles.heading}>Deployment Portal</p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="username">
            Username
          </label>
          <input
            id="username"
            className={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        <button type="submit" className={styles.submit} disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        {login.data && !login.data.ok && <p className={styles.error}>{login.data.message}</p>}
        {login.isError && <p className={styles.error}>{(login.error as Error).message}</p>}
      </form>
    </div>
  )
}
