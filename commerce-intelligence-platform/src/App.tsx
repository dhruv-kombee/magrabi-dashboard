import { CommerceDashboard } from './CommerceDashboard'
import { AuthGate } from './AuthGate'

export default function App() {
  return <AuthGate>{(session) => <CommerceDashboard role={session.role} />}</AuthGate>
}
