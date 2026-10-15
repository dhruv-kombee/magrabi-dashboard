import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { TraceSummary } from './types'
import { safeGrafanaLink, spanPosition } from './traceLayout'
import { TraceJourney } from './TraceJourney'
import { lookupTrace, TraceLookupError } from './traceRequest'
import type { TraceLoader } from './traceRequest'
import styles from './MonitoringPanel.module.css'

type Props = {
  role: 'admin' | 'viewer' | null
  configured?: boolean
  /** Inject the reviewed same-origin API client; no default network connection or demo data. */
  loadTrace?: TraceLoader
  initialTraceId?: string
  embedded?: boolean
}

/** UI defense only. Every real monitoring API independently enforces admin authorization. */
export function MonitoringPanel({ role, configured = false, loadTrace, initialTraceId, embedded }: Props) {
  if (role !== 'admin') return null
  return <AdminTracePanel configured={configured} loadTrace={loadTrace} initialTraceId={initialTraceId} embedded={embedded} />
}

function AdminTracePanel({ configured, loadTrace, initialTraceId, embedded }: Omit<Props, 'role'>) {
  const [id, setId] = useState(initialTraceId ?? '')
  const [trace, setTrace] = useState<TraceSummary | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => () => {
    const previous = inFlight.current
    inFlight.current = null
    previous?.abort()
  }, [])
  useEffect(() => {
    const previous = inFlight.current
    inFlight.current = null
    previous?.abort()
    setTrace(null)
    setSelected(null)
    setBusy(false)
    setError('')
  }, [configured, loadTrace])

  const runLookup = useCallback(async (rawId: string) => {
    if (!configured || !loadTrace) return
    // Pad first, then require exactly 32: a short ID from Grafana becomes canonical, while
    // anything over-long or non-hexadecimal still fails.
    const query = rawId.trim().toLowerCase().padStart(32, '0')
    if (!/^[a-f0-9]{32}$/.test(query) || /^0+$/.test(query)) {
      setError('Enter a nonzero hexadecimal trace ID of up to 32 characters.')
      return
    }
    inFlight.current?.abort()
    const request = new AbortController()
    inFlight.current = request
    setBusy(true)
    setError('')
    setTrace(null)
    setSelected(null)
    try {
      const result = await lookupTrace(loadTrace, query, request)
      if (inFlight.current !== request || request.signal.aborted) return
      setTrace(result)
    } catch (error) {
      if (inFlight.current === request) setError(error instanceof TraceLookupError && error.code === 'timed_out'
        ? 'The lookup timed out. Try again with a retained SIT trace.'
        : 'Trace unavailable. It may not be retained, in the enabled SIT scope, or the backend may be unavailable.')
    } finally {
      if (inFlight.current === request) {
        inFlight.current = null
        setBusy(false)
      }
    }
  }, [configured, loadTrace])
  useEffect(() => {
    // Site traffic and component candidate selections open the journey immediately. A manual
    // lookup still runs only on form submission; typing cannot start telemetry requests.
    if (initialTraceId) void runLookup(initialTraceId)
  }, [initialTraceId, runLookup])
  function search(event: FormEvent) {
    event.preventDefault()
    if (!busy) void runLookup(id)
  }

  const shownSpans = trace?.spans.filter(s => !selected || s.service_id === selected) ?? []
  const selectedNode = trace?.nodes.find(n => n.id === selected)
  const logsUrl = safeGrafanaLink(trace?.log_correlation?.trace_and_logs_url, trace?.trace_id,
    trace?.nodes)
  return <section className={styles.panel} aria-label={embedded ? 'Manual trace lookup' : 'Monitoring trace lookup'}>
    {!embedded && <><header className={styles.header}>
      <div><h1 id="monitoring-title">Monitoring</h1><p>Admin access · SIT first</p></div>
      <span className={styles.scope}>Trace lookup · reviewed SIT services</span>
    </header>
    <nav className={styles.environments} aria-label="Monitoring environment">
      <button type="button" aria-current="page">SIT</button>
      {['Dev', 'Beta', 'Prod'].map(name => <button key={name} type="button" disabled title="Environment mapping and monitoring are not configured">{name} · not configured</button>)}
    </nav></>}
    {!configured && <p className={styles.notice}>Monitoring is not connected to this portal yet. No live traffic or service health is being shown.</p>}
    <form className={styles.search} onSubmit={search}>
      <label htmlFor="monitoring-trace-id">Trace ID</label>
      <div><input id="monitoring-trace-id" value={id} onChange={event => setId(event.target.value)} maxLength={32}
        placeholder="Trace ID" autoComplete="off" spellCheck={false} disabled={!configured || busy} />
        <button type="submit" disabled={!configured || !loadTrace || busy}>{busy ? 'Looking up…' : 'Follow trace'}</button></div>
    </form>
    <p className={styles.hint}>A trace shows the spans that were retained. Missing instrumentation can leave parts of a request invisible.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!trace && !busy && configured && <p className={styles.empty}>Paste a trace ID to inspect its observed service path, timings and error spans.</p>}
    {trace && <>
      <div className={styles.summary}>
        <div><span>Observed duration</span><strong>{trace.observed_duration_ms.toLocaleString()} ms</strong></div>
        <div><span>Services in this trace</span><strong>{trace.nodes.length}</strong></div>
        <div><span>Returned spans</span><strong>{trace.span_count}</strong></div>
        <div><span>Spans with errors</span><strong>{trace.error_span_ids.length}</strong></div>
      </div>
      {trace.known_partial && <p className={styles.notice}>Partial trace: {trace.missing_parents.length} parent spans are missing, or the root structure is incomplete.</p>}
      <TraceJourney trace={trace} selectedService={selected} onSelect={setSelected} />
      <div className={styles.graphHeading}><h2>{selectedNode ? selectedNode.service : 'All services'} — span timings</h2>
        {selected && <button type="button" onClick={() => setSelected(null)}>Show all services</button>}</div>
      <p className={styles.hint}>Error spans are observations, not proof that a service is down or the root cause. Overlapping span durations must not be added as request latency.</p>
      <div className={styles.tableScroll}><table><thead><tr><th>Service / span</th><th>Timing</th><th>Duration</th><th>Observation</th></tr></thead>
        <tbody>{shownSpans.slice(0, 100).map(span => <tr key={span.span_id}><td>{span.service}<code>{span.span_id}</code></td>
          <td><div className={styles.track}><div className={span.error_observed ? styles.barError : styles.bar}
            style={{ marginLeft: `${spanPosition(span.start_offset_ms, span.duration_ms, trace.observed_duration_ms).left}%`,
              width: `${spanPosition(span.start_offset_ms, span.duration_ms, trace.observed_duration_ms).width}%` }} /></div></td>
          <td>{span.duration_ms.toLocaleString()} ms</td><td>{span.error_observed ? 'Error recorded' : 'No error recorded'} · {span.kind}</td></tr>)}</tbody></table></div>
      {shownSpans.length > 100 && <p className={styles.hint}>Showing the first 100 of {shownSpans.length} spans. Use Grafana for the complete returned trace.</p>}
      {logsUrl ? <a className={styles.logs} href={logsUrl} target="_blank" rel="noopener noreferrer">Open trace and correlated logs in Grafana</a>
        : <p className={styles.hint}>{trace.log_correlation?.status === 'trace_window_exceeds_log_link_limit'
          ? 'This trace exceeds the bounded log-search window. No automatic log link was generated.'
          : 'Log links are not configured for this trace.'}</p>}
      <p className={styles.hint}>Grafana requires its own access. A link does not establish that matching log lines are retained.</p>
    </>}
  </section>
}
