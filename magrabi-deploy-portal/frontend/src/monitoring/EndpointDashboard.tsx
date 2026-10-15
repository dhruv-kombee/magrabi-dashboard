import { useEffect, useRef, useState } from 'react'
import type { Component, Dashboard, Health } from './dashboardModel'
import { componentLogs, connectedComponents, decodeDashboard, decodeTraceCandidates } from './dashboardModel'
import type { Rum, RumSite } from './rumModel'
import { decodeRum, formatVital, rating, siteFor, siteSessionsLink } from './rumModel'
import styles from './EndpointDashboard.module.css'

type Props = { configured: boolean; loadDashboard: (signal: AbortSignal) => Promise<unknown>
  loadCandidates: (component: string, signal: AbortSignal) => Promise<unknown>; onTrace: (id: string) => void
  loadRum?: (signal: AbortSignal) => Promise<unknown> }
const labels: Record<Health, string> = { healthy: 'No issue observed', error: 'Needs attention', unknown: 'Unknown', idle: 'No recent traffic' }
const metric = (v: number | null, suffix = '') => v === null ? 'Unknown' : v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + suffix

export function EndpointDashboard({ configured, loadDashboard, loadCandidates, onTrace, loadRum }: Props) {
  const [data, setData] = useState<Dashboard | null>(null), [selected, setSelected] = useState<string | null>(null)
  const [rum, setRum] = useState<Rum | null>(null)
  const [component, setComponent] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const [clock, setClock] = useState(Date.now()), [refresh, setRefresh] = useState(0)
  const active = useRef<AbortController | null>(null), lastAttempt = useRef(0)
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!configured) { setData(null); return }
    async function fetchSnapshot() {
      if (document.hidden || active.current || Date.now() - lastAttempt.current < 30000) return
      const request = new AbortController(); active.current = request; lastAttempt.current = Date.now(); setBusy(true)
      const timeout = setTimeout(() => request.abort(), 12000)
      try {
        const snapshot = decodeDashboard(await loadDashboard(request.signal))
        if (active.current === request && !request.signal.aborted) { setData(snapshot); setError(false) }
        // Real-user numbers ride the same refresh but fail on their own: a bad or missing RUM
        // answer clears the "Users" line and nothing else.
        if (loadRum) {
          try { const users = decodeRum(await loadRum(request.signal)); if (active.current === request && !request.signal.aborted) setRum(users) }
          catch { if (active.current === request) setRum(null) }
        }
      } catch { if (active.current === request) { setError(true); setData(null); setRum(null) } }
      finally { clearTimeout(timeout); if (active.current === request) { active.current = null; setBusy(false) } }
    }
    void fetchSnapshot()
    const timer = setInterval(() => void fetchSnapshot(), 30000)
    const visible = () => { if (!document.hidden) void fetchSnapshot() }
    document.addEventListener('visibilitychange', visible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); active.current?.abort(); active.current = null; lastAttempt.current = 0 }
  }, [configured, loadDashboard, loadRum, refresh])
  const rumStale = !rum || clock / 1000 - rum.generated_at > 125 || rum.generated_at > clock / 1000 + 30
  const users = (hostName: string): RumSite | undefined => rumStale ? undefined : siteFor(rum, hostName)
  const stale = !data || clock / 1000 >= data.health_valid_until || clock / 1000 - data.generated_at > 65 || data.generated_at > clock / 1000 + 30
  const state = (value: Health): Health => stale ? 'unknown' : value
  const endpoint = data?.endpoints.find(e => e.id === selected)
  const components = data && endpoint ? connectedComponents(data, endpoint) : []
  const selectedComponent = components.find(c => c.id === component)
  const shownEdges = data?.edges.filter(e => e.evidence === 'configured_dependency' && components.some(c => c.id === e.source)) ?? []
  return <section className={styles.dashboard} aria-label="SIT endpoint monitoring">
    <div className={styles.toolbar}>
      <div><h2>{endpoint ? endpoint.name : 'Websites & endpoints'}</h2><p>Last 5 minutes · SIT only · updates every 30 seconds</p></div>
      <button onClick={() => setRefresh(n => n + 1)} disabled={!configured || busy || clock - lastAttempt.current < 30000}>{busy ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    <div className={styles.legend}><span className={styles.healthy}>No issue observed</span><span className={styles.error}>Error or readiness issue</span><span className={styles.unknown}>Unknown / missing telemetry</span></div>
    {!configured && <p className={styles.notice}>The endpoint dashboard is not connected. Trace lookup is available separately when configured.</p>}
    {error && <p role="alert" className={styles.notice}>The health snapshot is unavailable. Previous green states are not being reused.</p>}
    {busy && !data && <p role="status">Reading endpoint and component signals…</p>}
    {data && <>
      <div className={styles.breadcrumb}><button onClick={() => { setSelected(null); setComponent(null) }}>SIT endpoints</button>
        {endpoint && <><span>/</span><span>{endpoint.host}</span></>}</div>
      {(stale || data.telemetry === 'unavailable') && <p className={styles.notice}>Live metrics are unavailable or stale. The verified route inventory is shown, but health is unknown.</p>}
      {!stale && data.telemetry === 'available' && data.ingress_collection !== 'complete' && <p className={styles.notice}>Ingress traffic collection is incomplete, warming up or unavailable. Request totals, error counts and latency stay unknown until every controller is reporting. Component readiness is shown separately.</p>}
      {!endpoint ? <div className={styles.tiles}>{data.endpoints.map(e => <button key={e.id} className={`${styles.tile} ${styles[state(e.health)]}`}
        onClick={() => { setSelected(e.id); setComponent(null) }}>
        <span className={styles.tileTop}><span>{e.type === 'website' ? 'Website' : 'API endpoint'}</span><span>{labels[state(e.health)]}</span></span>
        <strong>{e.name}</strong><span className={styles.host}>{e.host}</span>
        {!stale && e.dependency_issue && <span>A configured dependency has a readiness issue.</span>}
        <span className={styles.tileMetrics}><span>Requests <b>{stale ? 'Unknown' : metric(e.requests)}</b></span>
          <span>4xx / 5xx <b>{stale ? 'Unknown' : `${metric(e.errors_4xx)} / ${metric(e.errors_5xx)}`}</b></span>
          <span>p95 <b>{stale ? 'Unknown' : metric(e.p95_ms, ' ms')}</b></span></span>
        {e.type === 'website' && <UsersLine site={users(e.host)} />}
        <span className={styles.drill}>Explore services</span>
      </button>)}</div> : <>
        <div className={`${styles.endpoint} ${styles[state(endpoint.health)]}`}><div><strong>{endpoint.host}</strong><p>{labels[state(endpoint.health)]}</p></div>
          <div>Requests <b>{stale ? 'Unknown' : metric(endpoint.requests)}</b></div><div>4xx <b>{stale ? 'Unknown' : metric(endpoint.errors_4xx)}</b></div>
          <div>5xx <b>{stale ? 'Unknown' : metric(endpoint.errors_5xx)}</b></div><div>p95 <b>{stale ? 'Unknown' : metric(endpoint.p95_ms, ' ms')}</b></div></div>
        {endpoint.type === 'website' && <RealUsers site={users(endpoint.host)} at={rum?.generated_at ?? 0} />}
        <h3>Configured service map</h3>
        <p className={styles.hint}>Solid route labels identify the configured entry services. Dependencies below come from verified configuration, not a recorded request. Open a retained trace to see an observed path.</p>
        <div className={styles.flowEntry}><span>{endpoint.host}</span><span>Ingress routes to</span></div>
        <div className={styles.components}>{components.map(c => <button key={c.id} aria-pressed={component === c.id}
          className={`${styles.component} ${styles[state(c.health)]}`} onClick={() => setComponent(c.id)}>
          <span>{endpoint.component_ids.includes(c.id) ? 'Entry service' : 'Configured dependency'}</span><strong>{c.service}</strong>
          <span>{c.namespace}</span><span>{state(c.health) === 'idle' ? 'Scaled to zero' : labels[state(c.health)]} · {stale ? 'Unknown' : metric(c.ready)} / {stale ? 'Unknown' : metric(c.desired)} replicas ready</span>
        </button>)}</div>
        {!!shownEdges.length && <div className={styles.dependencies}><h4>Configured connections</h4>{shownEdges.map(e => <div key={e.source + e.target}><code>{e.source.split('/')[1]}</code><span>calls / connects to</span><code>{e.target.split('/')[1]}</code></div>)}</div>}
        {!shownEdges.length && <p className={styles.notice}>Downstream request paths are not established for this endpoint yet. This is not an end-to-end green health check.</p>}
        {selectedComponent ? <ComponentDetail key={selectedComponent.id} component={selectedComponent} at={data.generated_at}
          stale={stale} loadCandidates={loadCandidates} onTrace={onTrace} /> : <p className={styles.hint}>Select a service above to inspect its component, logs and retained traces.</p>}
      </>}
      <p className={styles.hint}>HTTP errors and configured component issues are observations, not a root-cause diagnosis. Readiness does not prove application behaviour, and scraped ingress data does not prove complete traffic coverage. Snapshot: {new Date(data.generated_at * 1000).toLocaleTimeString()}.</p>
    </>}
  </section>
}

const vitalLabels = { lcp_p75_ms: 'LCP', inp_p75_ms: 'INP', cls_p75: 'CLS', ttfb_p75_ms: 'TTFB' } as const
const count = (v: number | null) => v === null ? 'Unknown' : v.toLocaleString()

/** One line on a website tile: what real browsers saw in the last hour. Absent data reads Unknown, never zero. */
function UsersLine({ site }: { site?: RumSite }) {
  const vital = (kind: keyof typeof vitalLabels) => site ? <b className={styles[rating(kind, site[kind])]}>{formatVital(kind, site[kind])}</b> : <b>Unknown</b>
  return <span className={styles.users}><span>Browser observations (1 h)</span>
    <span>LCP {vital('lcp_p75_ms')}</span><span>INP {vital('inp_p75_ms')}</span><span>Errors <b>{site ? count(site.js_errors) : 'Unknown'}</b></span></span>
}

/** The detail block: seven numbers, in plain words, plus the Grafana session view. */
function RealUsers({ site, at }: { site?: RumSite; at: number }) {
  const link = site ? siteSessionsLink(site, at) : undefined
  return <section className={styles.realUsers} aria-label="Browser observations, last hour">
    <div className={styles.realUsersHead}><h3>Browser observations - last hour</h3>
      {link && <a href={link} target="_blank" rel="noopener noreferrer">Open sessions in Grafana</a>}</div>
    <dl>
      <div><dt>Observed TTFB measurements</dt><dd>{site ? count(site.page_loads) : 'Unknown'}</dd></div>
      <div><dt>Observed sessions</dt><dd>{site ? count(site.sessions) : 'Unknown'}</dd></div>
      <div><dt>Observed JS errors</dt><dd>{site ? count(site.js_errors) : 'Unknown'}</dd></div>
      {(Object.keys(vitalLabels) as (keyof typeof vitalLabels)[]).map(kind => <div key={kind}><dt>{vitalLabels[kind]} p75</dt>
        <dd className={site ? styles[rating(kind, site[kind])] : undefined}>{site ? formatVital(kind, site[kind]) : 'Unknown'}</dd></div>)}
    </dl>
    <p className={styles.hint}>These are retained browser measurements, not total visitors or page loads. Missing SDKs, sampling and
      delivery gaps can omit observations; TTFB measurements are not guaranteed to occur once per navigation.
      p75 = the 75th percentile of the retained measurements. Green, amber and red follow web-vital guidance
      thresholds (LCP 2.5 s / 4 s, INP 200 / 500 ms, CLS 0.1 / 0.25, TTFB 0.8 / 1.8 s). LCP - how long until the main content is visible.
      INP - how quickly the page reacts to a tap or click. CLS - how much the page jumps around while loading. TTFB - how long the server
      took to start answering. "Unknown" means no usable evidence for this site or signal in the last hour, or a failed query.
      Zero observed JS errors is shown only when this site's current-window browser activity was observed and its error query succeeded;
      it is not proof that every request was healthy.</p>
  </section>
}

function ComponentDetail({ component, at, stale, loadCandidates, onTrace }: { component: Component; at: number; stale: boolean
  loadCandidates: Props['loadCandidates']; onTrace: Props['onTrace'] }) {
  const [traces, setTraces] = useState<{ trace_id: string }[] | null>(null), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => { active.current?.abort(); active.current = null }, [])
  async function findTraces() {
    if (active.current) return
    const request = new AbortController(); active.current = request; setBusy(true); setFailed(false); setTraces(null)
    const timeout = setTimeout(() => request.abort(), 12000)
    try { const values = decodeTraceCandidates(await loadCandidates(component.id, request.signal)); if (!request.signal.aborted) setTraces(values) }
    catch { if (active.current === request) setFailed(true) }
    finally { clearTimeout(timeout); if (active.current === request) { active.current = null; setBusy(false) } }
  }
  const logs = componentLogs(component, at)
  return <aside className={styles.detail} aria-label="Selected service details"><h3>{component.service}</h3>
    <dl><div><dt>Namespace</dt><dd>{component.namespace}</dd></div><div><dt>Component</dt><dd>{component.deployment ?? 'Deployment mapping missing'}</dd></div>
      <div><dt>Readiness</dt><dd>{stale ? 'Unknown' : `${metric(component.ready)} / ${metric(component.desired)}`}</dd></div></dl>
    <div className={styles.actions}>{logs && <a href={logs} target="_blank" rel="noopener noreferrer">Open component logs in Grafana</a>}
      {component.trace_search && <button onClick={() => void findTraces()} disabled={busy}>{busy ? 'Finding traces…' : 'Find recent traces'}</button>}</div>
    <p className={styles.hint}>Logs open for this deployment and snapshot window, up to 100 lines. Grafana access is required; matching log retention has not been verified. Raw log text is not copied into this portal.</p>
    {!component.trace_search && <p className={styles.notice}>Trace coverage is not yet verified for this component. Its readiness and logs do not establish the full request path.</p>}
    {failed && <p role="alert">Retained trace search is unavailable.</p>}
    {traces && <><p className={styles.hint}>Up to 10 retained matches from the 3–15 minute window at search time, not a live request count. Complete SIT scope is checked when opened.</p>
      {traces.length ? <div className={styles.traceList}>{traces.map(t => <button key={t.trace_id} onClick={() => onTrace(t.trace_id)}><code>{t.trace_id}</code><span>Use in trace lookup</span></button>)}</div>
        : <p>No retained trace matched this component in the search window.</p>}</>}
  </aside>
}
