import { useEffect, useState } from 'react'
import { MonitoringPanel } from './MonitoringPanel'
import { createMonitoringClient } from './client'
import { EndpointDashboard } from './EndpointDashboard'
import { ServiceMap } from './ServiceMap'
import { LiveTraffic } from './LiveTraffic'
import { SyntheticMonitoring } from './SyntheticMonitoring'
import styles from './MonitoringPanel.module.css'

const client = createMonitoringClient((...args) => fetch(...args))

/** Mounted only behind the portal's existing admin RequireRole boundary. Server gates every API. */
export function MonitoringPage() {
  const [configured, setConfigured] = useState(false)
  const [checking, setChecking] = useState(true)
  const [section, setSection] = useState<'map' | 'dashboard' | 'traffic' | 'trace' | 'synthetics'>(
    () => new URLSearchParams(window.location.search).get('view') === 'synthetics' ? 'synthetics' : 'map')
  const [selectedTrace, setSelectedTrace] = useState<string | undefined>()
  useEffect(() => {
    const request = new AbortController()
    const timeout = setTimeout(() => request.abort(), 5000)
    void client.configured(request.signal).then(enabled => {
      if (!request.signal.aborted) setConfigured(enabled)
    }).catch(() => { /* No auth errors, raw response or backend details are rendered. */ }).finally(() => {
      clearTimeout(timeout)
      if (!request.signal.aborted) setChecking(false)
    })
    const onAbort = () => setChecking(false)
    request.signal.addEventListener('abort', onAbort)
    return () => { request.signal.removeEventListener('abort', onAbort); request.abort(); clearTimeout(timeout) }
  }, [])
  return <main className={styles.panel}>
    <header className={styles.header}><div><h1>Monitoring</h1><p>Magrabi platform · Admin access</p></div><a href="/admin">Builds & deployments</a></header>
    <nav className={styles.environments} aria-label="Monitoring environment"><button type="button" aria-current="page">SIT</button>
      {['Dev', 'Beta', 'Prod'].map(name => <button key={name} type="button" disabled>{name} · not configured</button>)}</nav>
    <nav className={styles.environments} aria-label="Monitoring view">
      <button type="button" aria-current={section === 'map' ? 'page' : undefined} onClick={() => setSection('map')}>Service map</button>
      <button type="button" aria-current={section === 'dashboard' ? 'page' : undefined} onClick={() => setSection('dashboard')}>Endpoint dashboard</button>
      <button type="button" aria-current={section === 'traffic' ? 'page' : undefined} onClick={() => setSection('traffic')}>Live traffic</button>
      <button type="button" aria-current={section === 'trace' ? 'page' : undefined} onClick={() => setSection('trace')}>Trace lookup</button>
      <button type="button" aria-current={section === 'synthetics' ? 'page' : undefined} onClick={() => setSection('synthetics')}>Synthetic monitoring</button>
    </nav>
    {checking && <p role="status">Checking SIT monitoring connection…</p>}
    {section === 'map' && <ServiceMap configured={configured} loadMap={client.serviceMap} />}
    {section === 'dashboard' && <EndpointDashboard configured={configured} loadDashboard={client.dashboard} loadCandidates={client.candidates}
      loadRum={client.rum} onTrace={id => { setSelectedTrace(id); setSection('trace') }} />}
    {section === 'traffic' && <LiveTraffic configured={configured} loadTraffic={client.traffic}
      onTrace={id => { setSelectedTrace(id); setSection('trace') }} />}
    {section === 'trace' && <MonitoringPanel key={selectedTrace ?? 'manual'} role="admin"
      configured={configured} loadTrace={client.trace} initialTraceId={selectedTrace} embedded />}
    {section === 'synthetics' && <SyntheticMonitoring />}
  </main>
}
