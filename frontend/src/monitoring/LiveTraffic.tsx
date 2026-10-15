import { useEffect, useRef, useState } from 'react'
import { TRAFFIC_SITES, trafficFresh } from './trafficModel'
import type { Traffic, TrafficRow } from './trafficModel'
import { loadSiteTraffic } from './trafficRequest'
import type { TrafficLoader } from './trafficRequest'
import { journeyDuration } from './traceJourneyModel'
import styles from './LiveTraffic.module.css'

type Props = { configured: boolean; loadTraffic: TrafficLoader; onTrace: (id: string) => void }

export function TrafficRows({ rows, onTrace }: { rows: TrafficRow[]; onTrace: (id: string) => void }) {
  return <div className={styles.tableScroll}><table><thead><tr><th>Time</th><th>Reported by</th><th>Route template</th><th>Method</th>
    <th>HTTP</th><th>Selected span</th><th>HTTP / trace issue</th><th>Trace journey</th></tr></thead><tbody>
    {rows.map(row => <tr key={row.trace_id} className={row.error === true ? styles.errorRow : undefined}
      onClick={() => onTrace(row.trace_id)}>
      <td>{new Date(row.at * 1000).toLocaleTimeString()}</td><td>{row.kind === 'browser' ? 'Browser (self-reported)' : 'Server instrumentation'}</td>
      <td>{row.route ?? 'Unknown / withheld'}</td><td>{row.method ?? 'Unknown'}</td><td>{row.status ?? 'Unknown'}</td>
      <td>{journeyDuration(row.duration_ms)}</td><td>{row.error === null ? 'Unknown' : row.error ? 'Recorded' : 'Not recorded'}</td>
      <td><button type="button" onClick={event => { event.stopPropagation(); onTrace(row.trace_id) }}
        aria-label={`Open trace journey ${row.trace_id}`}><code>{row.trace_id}</code></button></td>
    </tr>)}
  </tbody></table></div>
}

/** Separate from aggregates. Read only the selected site, with one in-flight request, visible-tab
 *  polling and cancellation on site/configuration/unmount changes. No background work on imports. */
export function LiveTraffic({ configured, loadTraffic, onTrace }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const site = TRAFFIC_SITES.find(s => s.host === selected)
  return <section className={styles.traffic} aria-label="SIT live traffic">
    <header><h2>Live traffic</h2><p>Select a website to inspect recently retained, site-attributed traces.</p></header>
    <p className={styles.notice}>This is a bounded trace list, not a complete request log: at most four trace candidates are checked per refresh,
      with one selected site span per trace. Instrumentation, collection and indexing can omit or delay requests.</p>
    {!configured && <p className={styles.notice}>SIT monitoring is not connected. No live requests are being shown.</p>}
    <div className={styles.sites} aria-label="SIT websites">{TRAFFIC_SITES.map(s => <button type="button" key={s.host}
      disabled={!configured} aria-pressed={selected === s.host} onClick={() => setSelected(s.host)}>
      <strong>{s.name}</strong><span>{s.host}</span></button>)}</div>
    {configured && site ? <SelectedSiteTraffic key={site.host} host={site.host} name={site.name} loadTraffic={loadTraffic} onTrace={onTrace} />
      : configured && <p className={styles.hint}>Choose a site above. Aggregate health remains in Endpoint dashboard; manual trace lookup remains available separately.</p>}
  </section>
}

function SelectedSiteTraffic({ host, name, loadTraffic, onTrace }: { host: string; name: string; loadTraffic: TrafficLoader; onTrace: (id: string) => void }) {
  const [data, setData] = useState<Traffic | null>(null), [error, setError] = useState(false), [busy, setBusy] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const active = useRef<AbortController | null>(null), lastAttempt = useRef(0)
  useEffect(() => {
    const clockTimer = setInterval(() => setClock(Date.now()), 1000)
    const fetchRows = async () => {
      if (document.hidden || active.current || Date.now() - lastAttempt.current < 10000) return
      const controller = new AbortController(); active.current = controller; lastAttempt.current = Date.now(); setBusy(true)
      try {
        const result = await loadSiteTraffic(loadTraffic, host, controller)
        if (active.current === controller && !controller.signal.aborted) { setData(result); setError(false) }
      } catch {
        if (active.current === controller) { setData(null); setError(true) }
      } finally { if (active.current === controller) { active.current = null; setBusy(false) } }
    }
    const visibility = () => {
      if (document.hidden) { const previous = active.current; active.current = null; previous?.abort(); setBusy(false) }
      else void fetchRows()
    }
    void fetchRows()
    const timer = setInterval(() => void fetchRows(), 10000)
    document.addEventListener('visibilitychange', visibility)
    return () => { clearInterval(timer); clearInterval(clockTimer); document.removeEventListener('visibilitychange', visibility)
      const previous = active.current; active.current = null; previous?.abort(); lastAttempt.current = 0 }
  }, [host, loadTraffic])
  const fresh = trafficFresh(data, clock / 1000), available = fresh && data?.telemetry === 'available'
  return <section className={styles.detail} aria-label={`${name} retained traffic`}>
    <header><div><h3>{name}</h3><p>{host}</p></div><span>{busy ? 'Reading…' : 'Updates every 10 seconds while visible'}</span></header>
    <p className={styles.hint}>Last 5 minutes · one row per retained trace · row timing and status describe its selected site span, not every request or the entire journey.</p>
    {error && <p role="alert" className={styles.notice}>Traffic is unavailable. No previous rows are being presented as live.</p>}
    {data && (!fresh || data.telemetry === 'unavailable') && <p role="status" className={styles.notice}>Traffic evidence is stale or incomplete. Rows are hidden until a fresh, successful read.</p>}
    {!data && !error && <p role="status">Waiting for the first traffic snapshot…</p>}
    {available && data && (data.rows.length ? <TrafficRows rows={data.rows} onTrace={onTrace} />
      : <p className={styles.notice}>No site-attributed trace was returned. This does not mean no traffic: the SDK or server tracing may not be live, or traces may not yet be retained/searchable.</p>)}
    <p className={styles.hint}>Browser host attribution is self-reported telemetry, not proof of origin. Opaque URLs, query strings, session IDs and personal data are never shown.
      Select a trace ID to open its journey; missing spans remain unknown.</p>
    <p className={styles.hint}>A traffic issue means HTTP 4xx/5xx or an OpenTelemetry error. The journey graph preserves its existing policy:
      recorded span errors and HTTP 5xx are red; HTTP 4xx alone does not turn its service box red. Neither view establishes whole-service health.</p>
    {available && data && <p className={styles.hint}>Snapshot: {new Date(data.generated_at * 1000).toLocaleTimeString()} · coverage incomplete.</p>}
  </section>
}
