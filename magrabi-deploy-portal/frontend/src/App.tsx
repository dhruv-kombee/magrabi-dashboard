import { Navigate, Route, Routes } from 'react-router-dom'
import { useIdentityQuery } from './api/hooks'
import { useTheme } from './hooks/useTheme'
import { NavHeader } from './components/NavHeader'
import { RequireRole } from './components/RequireRole'
import { LoginPage } from './routes/LoginPage'
import { StatusPage } from './routes/StatusPage'
import { DeploymentsPage } from './routes/DeploymentsPage'
import { AdminPage } from './routes/AdminPage'
import { ProductionPage } from './routes/ProductionPage'
import { VariablesPage } from './routes/VariablesPage'
import { KeyRotationPage } from './routes/KeyRotationPage'
import { FeedbackPage } from './routes/FeedbackPage'
import { InsightsPage } from './routes/InsightsPage'
import { LoggingPage } from './routes/LoggingPage'
import { MonitoringPage } from './monitoring/MonitoringPage'
import { CommercePage } from './commerce/CommercePage'

export default function App() {
  const { data, isLoading } = useIdentityQuery()
  const role = data?.role ?? null
  // Called unconditionally here (not inside NavHeader) so the persisted theme applies on the
  // pre-login page too, not just after NavHeader first mounts post-login.
  const { theme, toggle } = useTheme()

  if (isLoading) return null

  return (
    <>
      {role && <NavHeader role={role} theme={theme} onToggleTheme={toggle} />}
      <Routes>
        <Route path="/login" element={role ? <Navigate to="/status" replace /> : <LoginPage />} />
        <Route
          path="/status"
          element={
            <RequireRole role={role} allow={['admin', 'viewer']}>
              <StatusPage />
            </RequireRole>
          }
        />
        <Route
          path="/commerce"
          element={
            <RequireRole role={role} allow={['admin', 'viewer']}>
              <CommercePage />
            </RequireRole>
          }
        />
        <Route
          path="/deployments"
          element={
            <RequireRole role={role} allow={['admin', 'viewer']}>
              <DeploymentsPage />
            </RequireRole>
          }
        />
        {/* Deploy-TRIGGERING panel. Stays allow={['admin']} -- viewers get the read-only pages
            above and must never reach this one. */}
        <Route
          path="/admin"
          element={
            <RequireRole role={role} allow={['admin']}>
              <AdminPage />
            </RequireRole>
          }
        />
        {/* Beta and production. ADMIN ONLY, reads included -- the board names production
            applications, their pending approvals and their standing defects, which a read-only
            account has no need for. The nav link is hidden to match, but the real enforcement is
            @require_role("admin") on every /api/production/* route. */}
        <Route
          path="/production"
          element={
            <RequireRole role={role} allow={['admin']}>
              <ProductionPage />
            </RequireRole>
          }
        />
        {/* Both roles, but they get different screens. An admin can edit and add; a viewer gets a
            strictly read-only view. Credential values are scoped by _secret_visibility: full for an
            admin anywhere, masked for a viewer on DEV/SIT/UAT, and withheld entirely otherwise --
            and a viewer cannot reach BETA or PROD on that page at all. Every write route stays
            @require_role("admin"). */}
        <Route
          path="/variables"
          element={
            <RequireRole role={role} allow={['admin', 'viewer']}>
              <VariablesPage />
            </RequireRole>
          }
        />
        {/* Key Vault -> pipelines. ADMIN ONLY, reads included: pressing Sync here WRITES
            credentials into release definitions across every service, and Rollback restores an
            earlier vault version and pushes that out. No value is ever returned -- only hashes,
            lengths and version ids -- but the buttons are a credential write, so a viewer must
            not reach the page at all. Enforced by @require_role("admin") on every
            /api/keyvault/* route; this is the matching client-side gate. */}
        <Route
          path="/key-rotation"
          element={
            <RequireRole role={role} allow={['admin']}>
              <KeyRotationPage />
            </RequireRole>
          }
        />
        {/* The feedback INBOX -- triage over everyone's submissions, so admin-only. Submitting
            feedback is open to both roles, but that happens through the header button, not here. */}
        <Route
          path="/feedback"
          element={
            <RequireRole role={role} allow={['admin']}>
              <FeedbackPage />
            </RequireRole>
          }
        />
        {/* Both roles, matching /api/insights/funnel. It is a read-only counting view over
            production orders -- no customer, order number or amount is ever returned, only
            totals -- so a viewer seeing it is not a data-exposure decision. */}
        <Route
          path="/insights"
          element={
            <RequireRole role={role} allow={['admin', 'viewer']}>
              <InsightsPage />
            </RequireRole>
          }
        />
        {/* Both roles. Every /api/logs/* route is @require_role("admin", "viewer"), and the
            backend redacts credentials out of every log line before it is served. */}
        <Route
          path="/logging"
          element={
            <RequireRole role={role} allow={['admin', 'viewer']}>
              <LoggingPage />
            </RequireRole>
          }
        />
        <Route
          path="/monitoring"
          element={
            <RequireRole role={role} allow={['admin']}>
              <MonitoringPage />
            </RequireRole>
          }
        />
        {/* Landing stays /status deliberately. RequireRole's own deny-path also hardcodes
            '/status', so pointing the fallback somewhere else would leave two different
            "where do I send you" answers in the app -- change both together or neither. */}
        <Route path="*" element={<Navigate to={role ? '/status' : '/login'} replace />} />
      </Routes>
    </>
  )
}
