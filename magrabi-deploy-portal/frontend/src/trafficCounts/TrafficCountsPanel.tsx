import { useCallback, useEffect, useRef, useState } from 'react'
import { buildInput, classLabel, countLabel, dateInput, inputToIso, matchesRange, presetRange,
  rangeLabel, safeSourceUrl, sourceErrorMessage, sourceReadLabel, summaryCounts } from './model.ts'
import type { TrafficCatalog, TrafficReport, TrafficRow, TrafficSourceResult, TrafficTimezone } from './model.ts'
import { createTrafficCountsClient, csvPath, pollDelay, trafficErrorMessage } from './request.ts'
import styles from './TrafficCountsPanel.module.css'

const client = createTrafficCountsClient()
const STATUS_LABELS = { pending: 'Pending', running: 'Reading', complete: 'Complete', partial: 'Partial coverage', unavailable: 'Unavailable', failed: 'Failed' }
const SHORT_LABELS: Record<string, string> = { frontdoor_main: 'Front Door', ecom_cdn: 'Separate CDN',
  ecom_ingress: 'ECom ingress', macula_gateway: 'Macula gateway', filtered_storefront: 'Filtered storefront' }
const numberCell = (value: number | null) => <span className={value === null ? styles.unavailable : undefined}>{countLabel(value)}</span>

function CountsTable({ source, daily = false }: { source: TrafficSourceResult; daily?: boolean }) {
  const grouped = source.granularity === 'status_group'
  const rows = daily ? source.daily.flatMap(day => (day.rows.length ? day.rows : [{ scope: 'No count rows available', total: null, counts: {}, unclassified: null }])
    .map(row => ({ date: day.date, row, status: day.status, coverage: day.coverage })))
    : source.totals.map(row => ({ date: '', row, status: undefined, coverage: undefined }))
  if (!rows.length) return <p className={styles.empty}>No count rows are available for this source. This is not a zero-traffic result.</p>
  return <div className={styles.tableScroll} tabIndex={0} aria-label={daily ? 'Daily traffic counts table' : 'Traffic summary table'}>
    <table className={styles.table}>
      <thead><tr>{daily && <th scope="col">Date</th>}<th scope="col">Scope / traffic class</th><th scope="col">Total</th>
        {grouped ? <th scope="col">All 2xx</th> : <><th scope="col">200</th><th scope="col">Other 2xx</th></>}
        <th scope="col">3xx</th><th scope="col">4xx</th><th scope="col">5xx</th><th scope="col">Other</th></tr></thead>
      <tbody>{rows.map(({ date, row, status, coverage }, index) => {
        const unavailable = status === 'unavailable' || status === 'pending' || status === 'running'
        const n = summaryCounts(unavailable ? { ...row, total: null, unclassified: null } : row, source.granularity)
        return <tr key={`${date}-${row.scope}-${row.trafficClass ?? ''}-${index}`}>
          {daily && <td className={styles.date}>{date}{status && <small>{STATUS_LABELS[status]}</small>}
            {coverage && <small>{countLabel(coverage.observed)} / {countLabel(coverage.expected)} coverage units</small>}</td>}
          <th scope="row"><span>{classLabel(row.scope)}</span>{row.trafficClass && <small>{classLabel(row.trafficClass)}</small>}</th>
          <td className={styles.total}>{numberCell(n.total)}</td>
          {grouped ? <td>{numberCell(n.group2xx)}</td> : <><td>{numberCell(n.http200)}</td><td>{numberCell(n.other2xx)}</td></>}
          <td>{numberCell(n.group3xx)}</td><td>{numberCell(n.group4xx)}</td>
          <td className={n.group5xx && n.group5xx > 0 ? styles.errorCount : undefined}>{numberCell(n.group5xx)}</td><td>{numberCell(n.other)}</td>
        </tr>
      })}</tbody>
    </table>
  </div>
}

function CodeBreakdown({ rows, granularity }: { rows: TrafficRow[]; granularity: TrafficSourceResult['granularity'] }) {
  const keys = [...new Set([...rows.flatMap(row => Object.keys(row.counts).filter(k => k !== 'Unclassified')),
    ...(granularity === 'exact_status' ? ['200', '400', '401', '403', '404', '429', '499', '500', '501', '502', '503', '504'] : ['1xx', '2xx', '3xx', '4xx', '5xx'])])]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return <details className={styles.details}><summary>Response-code breakdown</summary>
    <p className={styles.hint}>Recorded HTTP statuses, not payment outcomes. HTTP 200 can still contain an application or GraphQL error.</p>
    <div className={styles.tableScroll} tabIndex={0} aria-label="Individual response codes">
      <table className={styles.table}><thead><tr><th scope="col">Response</th>{rows.map((r, i) => <th scope="col" key={i}>
        {classLabel(r.scope)}{r.trafficClass && <small>{classLabel(r.trafficClass)}</small>}</th>)}</tr></thead>
        <tbody>{keys.map(key => <tr key={key}><th scope="row">{key === '0' ? '0 · no HTTP response recorded' : key}</th>
          {rows.map((r, i) => <td key={i}>{numberCell(r.total === null ? null : r.counts[key] === undefined ? granularity === 'status_group' ? null : 0 : r.counts[key])}</td>)}</tr>)}
          <tr><th scope="row">Unclassified / reconciliation remainder</th>{rows.map((r, i) => <td key={i}>{numberCell(r.unclassified)}</td>)}</tr>
        </tbody>
      </table>
    </div>
  </details>
}

function SourceResults({ source }: { source: TrafficSourceResult }) {
  const available = source.status === 'complete' || source.status === 'partial'
  const partial = source.status === 'partial'
  const safeUrl = safeSourceUrl(source.url)
  const readLabel = sourceReadLabel(source)
  const sourceError = sourceErrorMessage(source.error)
  return <section className={styles.results} aria-labelledby="traffic-source-title">
    <div className={styles.sourceHeading}><div><p className={styles.eyebrow}>{source.layer}</p><h3 id="traffic-source-title">{source.label}</h3></div>
      <span className={`${styles.badge} ${partial || source.status === 'unavailable' ? styles.warningBadge : ''}`}>{STATUS_LABELS[source.status]}</span></div>
    {source.id === 'filtered_storefront' && <div className={styles.notice}>
      <strong>Customer-facing does not mean confirmed human traffic.</strong> Identifiable probes, telemetry, internal/scripted calls and crawler signatures are excluded from the retained category.
      The retained total includes browser-like and unknown clients, with unknown clients also broken out separately; disguised bots can remain.
      This subset is included in ECom ingress and must not be added to it.
    </div>}
    {source.status === 'unavailable' && <p className={styles.notice}>This source is unavailable for this report. Counts are not assumed to be zero.</p>}
    {sourceError && <p className={styles.notice}>{sourceError}</p>}
    {(source.status === 'pending' || source.status === 'running') && <p className={styles.empty} role="status">Waiting for this source. No counts have been inferred.</p>}
    {partial && <p className={styles.notice}><strong>Observed counts only.</strong> Missing data has not been filled or extrapolated. These are not complete-window totals.</p>}
    <p className={styles.hint}>Coverage units: {countLabel(source.coverage.observed)} observed / {countLabel(source.coverage.expected)} expected.
      {' '}Coverage of query bins is not proof that every request was logged.</p>
    {readLabel && <p className={styles.hint}>{readLabel}. Report generation time is not necessarily a fresh source read.</p>}
    {source.granularity === 'status_group' && <p className={styles.hint}>This source provides response groups only. Exact HTTP 200 and individual 500/502/503/504 counts are not available.</p>}
    {available && <>
      <h4 className={styles.sectionTitle}>{partial ? 'Observed window counts' : 'Window summary'}</h4>
      <CountsTable source={source} />
      <p className={styles.hint}>Other includes recorded 1xx, status 0 where present, and unclassified remainder. A dash means unavailable, not zero.</p>
      <h4 className={styles.sectionTitle}>By day <span>Selected timezone; first and last dates may be partial days</span></h4>
      <CountsTable source={source} daily />
      {!!source.totals.length && <CodeBreakdown rows={source.totals} granularity={source.granularity} />}
    </>}
    <footer className={styles.sourceNotes}><strong>Source and counting notes</strong>
      <ul>{source.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>
      {safeUrl && <a href={safeUrl} target="_blank" rel="noopener noreferrer">Open source · {source.label}</a>}
    </footer>
  </section>
}

export function TrafficCountsPanel() {
  const [catalog, setCatalog] = useState<TrafficCatalog | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [zone, setZone] = useState<TrafficTimezone>('Asia/Kolkata')
  const [range, setRange] = useState(() => presetRange('24h', 'Asia/Kolkata'))
  const [selected, setSelected] = useState<string[]>([])
  const [activeSource, setActiveSource] = useState('frontdoor_main')
  const [report, setReport] = useState<TrafficReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState(false)
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [cached, setCached] = useState(false)
  const activeRequest = useRef<AbortController | null>(null)
  const running = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    client.sources(controller.signal).then(result => {
      if (controller.signal.aborted) return
      setCatalog(result)
      const configured = result.sources.filter(s => s.configured).map(s => s.id)
      setSelected(configured.length ? configured : result.sources.map(s => s.id))
      setActiveSource(result.sources[0]?.id ?? '')
    }).catch(err => { if (!controller.signal.aborted) setCatalogError(trafficErrorMessage(err)) })
      .finally(() => { if (!controller.signal.aborted) setMetadataLoading(false) })
    return () => { controller.abort(); activeRequest.current?.abort() }
  }, [])

  const run = useCallback(async (rolling = false) => {
    if (!catalog || running.current || (rolling && document.visibilityState !== 'visible')) return
    const chosen = rolling ? presetRange('1h', zone) : range
    let input
    try { input = buildInput(chosen.start, chosen.end, zone, selected, catalog.maxDays, catalog.retentionDays) }
    catch (err) { setError(err instanceof Error ? err.message : 'Check the selected range.'); return }
    if (rolling) setRange(chosen)
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    running.current = true
    setBusy(true); setError(''); setCached(false)
    try {
      const ticket = await client.create(input, controller.signal)
      if (controller.signal.aborted) return
      setCached(ticket.cached)
      // The server bounds a complete report at60minutes; keep observing slightly longer so the
      // frontend does not silently abandon a job that is still legitimately collecting sources.
      const deadline = Date.now() + 65 * 60 * 1000
      while (!controller.signal.aborted) {
        const result = await client.report(ticket.id, controller.signal, input)
        if (controller.signal.aborted) return
        setReport(result)
        if (result.status !== 'running') {
          if (result.status === 'failed') setError('The report could not finish. See source availability; missing results are not zero.')
          break
        }
        if (Date.now() >= deadline) { setError('This report is taking longer than expected. The displayed snapshot is unfinished; no missing counts have been inferred.'); break }
        await pollDelay(controller.signal)
      }
    } catch (err) { if (!controller.signal.aborted) setError(trafficErrorMessage(err)) }
    finally {
      if (activeRequest.current === controller) {
        running.current = false
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }, [catalog, range, selected, zone])

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !running.current) void run(true) }, 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [live, run])

  const applyPreset = (preset: '1h' | '24h' | '5days') => { setLive(false); setRange(presetRange(preset, zone)); setError('') }
  const changeZone = (next: TrafficTimezone) => {
    setLive(false)
    try { setRange({ start: dateInput(Date.parse(inputToIso(range.start, zone)), next), end: dateInput(Date.parse(inputToIso(range.end, zone)), next) }) }
    catch { setRange(presetRange('24h', next)) }
    setZone(next)
  }
  let changed = false
  if (report && catalog) {
    try { changed = !matchesRange(report, buildInput(range.start, range.end, zone, selected, catalog.maxDays, catalog.retentionDays)) }
    catch { changed = true }
  }
  const currentSource = report?.sources.find(s => s.id === activeSource)
  const exportUrl = report && report.status !== 'running' && report.status !== 'failed' ? csvPath(report.id) : null

  return <section className={styles.panel} aria-labelledby="traffic-counts-heading">
    <header className={styles.heading}><div><p className={styles.eyebrow}>HTTP traffic · read-only</p><h2 id="traffic-counts-heading">Traffic counts</h2>
      <p>Compare HTTP responses across the edge and cluster for an exact time window.</p></div>
      {exportUrl && <a className={styles.exportButton} href={exportUrl}>Export this report · CSV</a>}</header>
    <p className={styles.boundary}><strong>Keep sources separate.</strong> The same request can be counted at multiple layers. Never add sources or parent/detail rows together; requests are not unique visitors or orders.</p>

    {metadataLoading && <p className={styles.empty} role="status">Loading traffic sources…</p>}
    {catalogError && <p className={styles.error} role="alert">{catalogError}</p>}
    {catalog && <>
      <div className={styles.filters}>
        <div className={styles.quickRanges} aria-label="Quick time ranges">
          <span>Quick range</span>{([['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['5days', 'Last 5 completed days']] as const).map(([preset, label]) =>
            <button key={preset} type="button" disabled={busy} onClick={() => applyPreset(preset)}>{label}</button>)}
        </div>
        <div className={styles.dateControls}>
          <label>From<input type="datetime-local" value={range.start} step="60" disabled={busy || live}
            onChange={event => setRange({ ...range, start: event.target.value })} /></label>
          <label>To · exclusive<input type="datetime-local" value={range.end} step="60" disabled={busy || live}
            onChange={event => setRange({ ...range, end: event.target.value })} /></label>
          <label>Timezone<select value={zone} disabled={busy || live} onChange={event => changeZone(event.target.value as TrafficTimezone)}>
            {catalog.timezones.map(z => <option key={z} value={z}>{z === 'Asia/Kolkata' ? 'IST · UTC+05:30' : 'UTC'}</option>)}</select></label>
          <button className={styles.primaryButton} type="button" disabled={busy || selected.length === 0} onClick={() => void run(live)}>
            {busy ? 'Reading sources…' : 'Run report'}</button>
        </div>
        <p className={styles.hint}>Maximum {catalog.maxDays} days per report, within the last {catalog.retentionDays} days. Individual sources may retain less data.</p>
        <fieldset className={styles.sourceSelection} disabled={busy}><legend>Sources to include</legend>
          {catalog.sources.map(source => <label key={source.id}><input type="checkbox" checked={selected.includes(source.id)}
            onChange={event => setSelected(event.target.checked ? [...selected, source.id] : selected.filter(id => id !== source.id))} />
            {SHORT_LABELS[source.id] ?? source.label}{!source.configured && <small>Not connected</small>}</label>)}
        </fieldset>
        <label className={styles.liveControl}><input type="checkbox" checked={live} disabled={busy && !live}
          onChange={event => { setLive(event.target.checked); if (event.target.checked) void run(true) }} />
          Refresh a rolling last hour every 5 minutes <span>Only while this tab is visible; off by default</span></label>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {busy && <div className={styles.progress} role="status" aria-live="polite"><span>Preparing report</span>
        {report?.status === 'running' ? <><progress value={report.progress.completed} max={Math.max(1, report.progress.total)} />
          <span>{report.progress.completed} / {report.progress.total} work units</span></> : <progress aria-label="Waiting for report" />}
      </div>}
      {report && <div className={styles.reportMeta}><strong>Displayed report: {rangeLabel(report.range)}</strong>
        <span>{STATUS_LABELS[report.status]}{report.generatedAt ? ` · Generated ${new Date(report.generatedAt).toLocaleString('en-GB', { timeZone: report.range.timezone })} ${report.range.timezone === 'UTC' ? 'UTC' : 'IST'}` : ''}
          {(cached || report.cached) ? ' · Saved/cached snapshot' : ''}</span>
        {changed && <span className={styles.stale}>Controls differ from this snapshot. Run report to apply them.</span>}
        {busy && report.status !== 'running' && <span className={styles.stale}>Previous snapshot remains visible while the new report loads.</span>}
      </div>}
      <nav className={styles.sourceTabs} aria-label="Traffic report source">
        {catalog.sources.map(source => <button key={source.id} type="button" aria-pressed={activeSource === source.id}
          onClick={() => setActiveSource(source.id)}>{SHORT_LABELS[source.id] ?? source.label}
          <small>{report?.sources.find(s => s.id === source.id) ? STATUS_LABELS[report.sources.find(s => s.id === source.id)!.status] : 'Not in displayed report'}</small></button>)}
      </nav>
      {currentSource ? <SourceResults source={currentSource} /> : <div className={styles.empty}>
        <strong>{report ? 'This source is not in the displayed report.' : 'Choose dates and run a report.'}</strong>
        <p>Counts are loaded on demand. Select this source above before running.</p>
      </div>}
      <p className={styles.version}>Filter rules: {catalog.filterVersion}. Filtered storefront is a heuristic subset, not a verified human-customer count.</p>
    </>}
  </section>
}
