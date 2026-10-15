import { NavLink, type NavLinkRenderProps } from 'react-router-dom'
import type { Role } from '../api/types'
import type { Theme } from '../hooks/useTheme'
import { useLogoutMutation } from '../api/hooks'
import logoUrl from '../assets/magrabi-logo.svg'
import { FeedbackButton } from './FeedbackButton'
import { ThemeToggle } from './ThemeToggle'
import styles from './NavHeader.module.css'

// Hoisted so the active-state rule lives in exactly one place; every link here styles identically
// and an inline copy per link is where they drift apart.
const navLinkClass = ({ isActive }: NavLinkRenderProps) =>
  isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink

export function NavHeader({ role, theme, onToggleTheme }: { role: Role; theme: Theme; onToggleTheme: () => void }) {
  const logout = useLogoutMutation()

  return (
    <header className={styles.header}>
      <img src={logoUrl} alt="Magrabi" className={styles.logo} />
      {/* The logo immediately to the left already reads "MAGRABI" -- repeating the brand here
          would render as "MAGRABI Magrabi Deployment Portal". The full name lives in the page
          title and on the login screen instead. */}
      <span className={styles.title}>Deployment Portal</span>
      <nav className={styles.nav}>
        {role === 'admin' && (
          <NavLink to="/monitoring" className={navLinkClass}>
            Monitoring
          </NavLink>
        )}
        {/* Sits next to Monitoring because it answers the other half of "is production
            healthy" -- not whether the services are up, but whether orders are actually
            completing. Both roles: it returns totals only, never an individual order. */}
        <NavLink to="/insights" className={navLinkClass}>
          Live Monitoring Insights
        </NavLink>
        {/* Read-only, and useful to both roles: a developer with a viewer account is exactly
            who needs to read a DEV function's logs without an Azure login. */}
        <NavLink to="/logging" className={navLinkClass}>
          Logging Dashboard
        </NavLink>
        <NavLink to="/deployments" className={navLinkClass}>
          Live Deployments
        </NavLink>
        <NavLink to="/status" className={navLinkClass}>
          Live Environment Status
        </NavLink>
        {/* Admin-only on purpose: /admin is the deploy-TRIGGERING panel, not a read-only view.
            The two links above are safe for viewers; this one must never render for them. */}
        {role === 'admin' && (
          <NavLink to="/admin" className={navLinkClass}>
            My Deployments
          </NavLink>
        )}
        {/* Beta and production. A SEPARATE page rather than another environment on the pages
            above, because the work is a different shape: up here a deployment is an ordered
            sequence of pipelines with its own approvals, not one pipeline with a status. Both
            roles can read it; nothing on it acts on its own. */}
        {role === 'admin' && (
          <NavLink to="/production" className={navLinkClass}>
            Beta &amp; Production
          </NavLink>
        )}
        {/* Both roles. A viewer gets a read-only screen and no BETA/PROD credential values;
            only an admin sees the edit and add controls. Enforced server-side, not here. */}
        <NavLink to="/variables" className={navLinkClass}>
          Variables
        </NavLink>
        {/* Sits immediately after Variables because it is the same subject from the other
            end: Variables edits one pipeline's values by hand, this pushes the vault's values to
            every pipeline at once. Admin-only -- the page's buttons write credentials across
            release definitions, so a viewer must not see the door, and every
            /api/keyvault/* route is @require_role("admin") regardless. */}
        {role === 'admin' && (
          <NavLink to="/key-rotation" className={navLinkClass}>
            Key Rotation
          </NavLink>
        )}
        {/* The triage INBOX over everyone's submissions -- admin-only, and distinct from the
            FeedbackButton below, which every role gets because anyone can raise a request. */}
        {role === 'admin' && (
          <NavLink to="/feedback" className={navLinkClass}>
            Feedback
          </NavLink>
        )}
      </nav>
      <div className={styles.spacer} />
      {/* An action, not a destination -- so it sits with the toggle/badge/logout cluster on the
          right rather than in the nav, and renders for both roles. */}
      <span className={styles.feedbackSlot}>
        <FeedbackButton />
      </span>
      <ThemeToggle theme={theme} toggle={onToggleTheme} />
      {role && <span className={styles.roleBadge}>{role}</span>}
      <button className={styles.logoutButton} onClick={() => logout.mutate()}>
        Log out
      </button>
    </header>
  )
}
