import { CommerceDashboard } from './CommerceDashboard'
import { AuthGate } from './AuthGate'

export default function App() {
  return <AuthGate>{(session, onLogout) => <CommerceDashboard role={session.role} username={session.username} permissions={session.permissions} onLogout={onLogout} />}</AuthGate>
}
