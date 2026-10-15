import { useEffect, useState } from 'react'
import { createSyntheticClient, loadSyntheticPage, SyntheticRequestError } from './syntheticClient'
import type { SyntheticLoader } from './syntheticClient'
import { REASON_TEXT, SYNTHETIC_STEPS, syntheticDuration, syntheticFresh, syntheticPassRate, syntheticTime } from './syntheticModel'
import type { SyntheticPage, SyntheticRun } from './syntheticModel'
import styles from './SyntheticMonitoring.module.css'

const PAGE_SIZE = 20
const stepLabels = { site: 'Site', login: 'Login', product: 'Product', cart: 'Cart', shipping: 'Shipping', payment: 'Payment boundary', return: 'Return', cleanup: 'Cleanup' }
const labels: Record<string, string> = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', running: 'Running', interrupted: 'Interrupted',
  pending: 'Pending', skipped: 'Skipped', verified: 'Verified', not_started: 'Not started', not_needed: 'Not needed' }
function Badge({ value }: { value: string }) {
  const tone = value === 'passed' || value === 'verified' ? 'good' : value === 'failed' ? 'bad'
    : value === 'blocked' || value === 'interrupted' ? 'warning' : value === 'running' ? 'active' : 'neutral'
  return <span className={`${styles.badge} ${styles[tone]}`}>{labels[value] ?? 'Unknown'}</span>
}

/** Dedicated read-only panel. No scheduler/account controls or write requests. */
export function SyntheticMonitoring({ loadRuns }: { loadRuns?: SyntheticLoader }) {
  const [defaultLoader] = useState(() => createSyntheticClient())
  const loader = loadRuns ?? defaultLoader
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(null)
  const [page, setPage] = useState<SyntheticPage | null>(null)
  const [error, setError] = useState<SyntheticRequestError['code'] | null>(null)
  const [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now())
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    let alive = true, active: AbortController | null = null
    setPage(null); setError(null); setSelected(null)
    const refresh = async () => {
      if (!alive || document.hidden || active) return
      const controller = new AbortController(); active = controller; setBusy(true)
      try {
        const result = await loadSyntheticPage(loader, { limit: PAGE_SIZE, offset }, controller)
        if (alive && active === controller && !controller.signal.aborted) { setPage(result); setError(null); setClock(Date.now()) }
      } catch (cause) {
        if (alive && active === controller && !controller.signal.aborted) {
          setError(cause instanceof SyntheticRequestError ? cause.code : 'unavailable')
        } else if (alive && active === controller && cause instanceof SyntheticRequestError && cause.code === 'timed_out') {
          setError('timed_out')
        }
      } finally { if (alive && active === controller) { active = null; setBusy(false) } }
    }
    const visibility = () => {
      setHidden(document.hidden); setClock(Date.now())
      if (document.hidden) { const previous = active; active = null; previous?.abort(); setBusy(false) }
      else void refresh()
    }
    void refresh()
    const timer = setInterval(() => { setClock(Date.now()); void refresh() }, 15_000)
    document.addEventListener('visibilitychange', visibility)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); active?.abort() }
  }, [loader, offset])

  const current = page?.pagination.offset === offset ? page : null
  const fresh = syntheticFresh(current, clock) && !error
  const detail = current?.runs.find(r => r.run_id === selected) ?? null
  const state = !current || !fresh ? 'unknown' : current.state
  const stateTitle = { unknown: 'Health unknown', disabled: 'Schedule disabled', ready: 'Waiting for next run',
    running: 'Journey in progress', attention_required: 'Paused · review required', stale: 'Runner evidence stale' }[state]
  return <section className={styles.panel} aria-labelledby="synthetic-monitoring-title">
    <header className={styles.header}><div><p className={styles.eyebrow}>Magrabi · SIT · automated journey</p>
      <h2 id="synthetic-monitoring-title">Synthetic Monitoring</h2>
      <p className={styles.subtitle}>One controlled checkout journey. Eight steps. A recorded outcome for each scheduled run.</p></div>
      <div className={styles.readOnly}>Read only <span>Hourly · UTC</span></div></header>

    <div className={styles.stateBar} data-state={state}><div><strong>{stateTitle}</strong>
      <p>{state === 'disabled' ? 'No scheduled journeys are being run. A disabled check cannot establish website health.'
        : state === 'attention_required' ? 'An interrupted run or uncertain cart cleanup requires an operator check before another journey.'
        : state === 'stale' ? 'The expected runner evidence is overdue. This is a monitoring gap, not proof the website is down.'
        : state === 'running' ? 'The runner reports an active journey. Step results below show only what has been verified.'
        : state === 'ready' ? 'Scheduling is configured. This flag alone does not prove the runner or website is healthy.'
        : 'No fresh monitoring result is available. Previous results, if shown, are historical only.'}</p></div>
      <span className={styles.polling}>{hidden ? 'Updates paused while hidden' : busy ? 'Reading results…' : 'Refreshes every 15 seconds'}</span></div>

    {error && <p className={styles.notice} role="alert">{error === 'unauthorized'
      ? 'An administrator session is required. Sign in again to read synthetic results.'
      : error === 'timed_out' ? 'Results took too long to respond. Website health is unknown.'
      : 'Synthetic results are unavailable or failed validation. No response details are exposed.'}</p>}
    {!current && !error && <p className={styles.empty} role="status">{hidden ? 'Open this tab to read monitoring results.' : 'Loading the first monitoring snapshot…'}</p>}
    {current && <>
      {!fresh && <p className={styles.notice}>Historical snapshot only · {syntheticTime(current.generated_at)}. Do not read an old green result as current health.</p>}
      <div className={styles.schedule}>
        <div><span>Schedule</span><strong>{current.schedule_enabled ? 'Every 60 minutes (configured)' : 'Disabled'}</strong></div>
        <div><span>Last run</span><strong>{syntheticTime(current.last_run_at)}</strong></div>
        <div><span>Next scheduled run</span><strong>{current.next_run_at ? syntheticTime(current.next_run_at) : 'Not scheduled / unknown'}</strong></div>
      </div>
      <div className={styles.metrics} aria-label="Retained history totals">
        <div><span>Pass rate</span><strong>{syntheticPassRate(current.summary)}</strong><small>Passed ÷ (passed + failed)</small></div>
        <div><span>Passed</span><strong className={styles.goodText}>{current.summary.passed}</strong></div>
        <div><span>Failed</span><strong className={styles.badText}>{current.summary.failed}</strong></div>
        <div><span>Blocked</span><strong className={styles.warningText}>{current.summary.blocked}</strong><small>Not counted as outages</small></div>
        <div><span>Interrupted</span><strong>{current.summary.interrupted}</strong></div>
        <div><span>Running</span><strong>{current.summary.running}</strong></div>
      </div>
      <p className={styles.hint}>Totals cover retained history (up to 14 days), not just this page. Blocked, interrupted and running journeys are excluded from the pass-rate denominator.
        Step timings include browser actions and network waits; they are not pure API latency.</p>
      <section className={styles.history} aria-label="Synthetic run history">
        <div className={styles.sectionHeading}><h3>Run history</h3><span>{current.pagination.total} retained runs · all timestamps UTC</span></div>
        {!current.runs.length ? <div className={styles.empty}><strong>No runs on this page</strong><p>{current.pagination.total === 0
          ? 'No success or failure has been inferred. An approved, configured journey is required before scheduled checks can run.'
          : 'History changed since this page was selected. Use Newer to return to available results.'}</p></div>
          : <div className={styles.tableScroll} tabIndex={0} aria-label="Scrollable eight-step run history"><table>
            <thead><tr><th scope="col">Started · UTC</th><th scope="col">Outcome / duration</th>{SYNTHETIC_STEPS.map(s => <th scope="col" key={s}>{stepLabels[s]}</th>)}<th scope="col">Review</th></tr></thead>
            <tbody>{current.runs.map(run => <tr key={run.run_id} className={selected === run.run_id ? styles.selected : undefined}>
              <th scope="row"><time dateTime={run.started_at}>{syntheticTime(run.started_at).replace(' UTC', '')}</time><small>{run.run_id.slice(0, 8)}</small></th>
              <td><Badge value={run.status} /><small>{syntheticDuration(run.duration_ms)}</small></td>
              {run.steps.map(step => <td key={step.id}><Badge value={step.status} /><small>{syntheticDuration(step.duration_ms)}</small></td>)}
              <td><button type="button" aria-expanded={selected === run.run_id} aria-controls="synthetic-run-detail"
                aria-label={`Review run ${run.run_id}`} onClick={() => setSelected(selected === run.run_id ? null : run.run_id)}>Details</button></td>
            </tr>)}</tbody></table></div>}
        <div className={styles.pagination}><span>{current.runs.length ? `${offset + 1}–${offset + current.runs.length}` : '0'} of {current.pagination.total}</span>
          <div><button type="button" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Newer</button>
            <button type="button" disabled={!current.pagination.has_more || offset + PAGE_SIZE > 10_000 || busy} onClick={() => setOffset(offset + PAGE_SIZE)}>Older</button></div></div>
      </section>
      {detail && <RunDetail run={detail} historical={!fresh} />}
    </>}
    <footer className={styles.boundary}><strong>Payment boundary, not payment completion.</strong> A passed run requires all eight steps, including the approved gateway boundary and verified cart cleanup.
      Checkout-only configuration stops before the gateway and is reported as blocked, not passed.
      No card details are entered or payment submitted. Reaching a real gateway can create an approved pending order or payment session; it does not prove payment completed.
      A blocked stock check is not a website-outage measurement.
      This panel contains no customer details, raw errors, URLs, screenshots or credentials.</footer>
  </section>
}

function RunDetail({ run, historical }: { run: SyntheticRun; historical: boolean }) {
  return <section id="synthetic-run-detail" className={styles.detail} aria-labelledby="synthetic-run-title">
    <div className={styles.sectionHeading}><h3 id="synthetic-run-title">Run detail{historical ? ' · historical' : ''}</h3><Badge value={run.status} /></div>
    <p className={styles.runId}>Run {run.run_id}</p>
    <dl className={styles.detailMeta}>
      <div><dt>Scheduled</dt><dd>{syntheticTime(run.scheduled_at)}</dd></div>
      <div><dt>Last runner update</dt><dd>{syntheticTime(run.updated_at)}</dd></div>
      <div><dt>Finished</dt><dd>{syntheticTime(run.finished_at)}</dd></div>
      <div><dt>Candidate attempts</dt><dd>{run.candidate_attempts} / 5 maximum</dd></div>
      <div><dt>Required boundary</dt><dd>{run.payment_boundary === 'gateway_reached' ? 'Reach gateway · do not pay' : 'Checkout only · gateway check blocked'}</dd></div>
      <div><dt>Cart cleanup</dt><dd><Badge value={run.cleanup_status} /></dd></div>
    </dl>
    {(run.cleanup_status === 'failed' || run.status === 'interrupted') && <p className={styles.notice}>Manual review required: do not retry this account until cart ownership and cleanup have been verified.</p>}
    <ol className={styles.stepList}>{run.steps.map((step, index) => <li key={step.id}>
      <span className={styles.stepNumber}>{index + 1}</span><div><div className={styles.stepHeading}><strong>{stepLabels[step.id]}</strong><Badge value={step.status} /></div>
        <p>{step.reason_code === 'none' ? step.status === 'pending' ? 'Not reached yet.' : step.status === 'running' ? 'In progress; outcome not yet known.' : step.status === 'skipped' ? 'Not executed.' : 'No issue recorded.' : REASON_TEXT[step.reason_code]}</p>
        <small>{syntheticDuration(step.duration_ms)}{step.http_status !== null ? ` · HTTP ${step.http_status}` : ''}</small></div>
    </li>)}</ol>
  </section>
}
