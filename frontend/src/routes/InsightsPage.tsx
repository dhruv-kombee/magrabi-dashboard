import { useState } from 'react'
import { useInsightsFunnelQuery } from '../api/hooks'
import type { InsightsFunnelRow } from '../api/types'
import styles from './InsightsPage.module.css'
import pageStyles from './Page.module.css'
import { TrafficCountsPanel } from '../trafficCounts/TrafficCountsPanel'
import trafficStyles from '../trafficCounts/TrafficCountsPanel.module.css'

/** Preset windows. Hours rather than minutes because that is how the question gets asked --
 *  "how many orders in the last 3 hours" -- and the custom box below covers everything else. */
const PRESETS = [
  { label: 'Last 1 hour', minutes: 60 },
  { label: 'Last 3 hours', minutes: 180 },
  { label: 'Last 4 hours', minutes: 240 },
  { label: 'Last 5 hours', minutes: 300 },
  { label: 'Last 6 hours', minutes: 360 },
  { label: 'Last 12 hours', minutes: 720 },
  { label: 'Last 24 hours', minutes: 1440 },
  { label: 'Last 3 days', minutes: 4320 },
  { label: 'Last 7 days', minutes: 10080 },
]

const REFRESH_OPTIONS = [
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: 'Paused', ms: 0 },
]

function describeWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes % 1440 === 0) {
    const d = minutes / 1440
    return `${d} day${d === 1 ? '' : 's'}`
  }
  const h = minutes / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`
}

/** A cell that reads as a number first and an explanation second. The share is of everyone who
 *  entered checkout in the window, which is the only denominator that makes the three columns
 *  add up. */
function Metric({ value, of, tone }: { value: number; of: number; tone: 'good' | 'warn' | 'bad' }) {
  const pct = of > 0 ? (value * 100) / of : null
  return (
    <div className={`${styles.metric} ${styles[tone]}`}>
      <span className={styles.metricValue}>{value.toLocaleString()}</span>
      {pct !== null && <span className={styles.metricShare}>{pct.toFixed(1)}%</span>}
    </div>
  )
}

function BrandRow({ row }: { row: InsightsFunnelRow }) {
  return (
    <tr>
      <th scope="row" className={styles.brandCell}>
        <span className={styles.brandName}>{row.label}</span>
        <span className={styles.brandChannels} title={row.channels.join(', ')}>
          {row.channels.length} channel{row.channels.length === 1 ? '' : 's'}
        </span>
      </th>
      <td>
        <Metric value={row.ordersPlaced} of={row.checkoutsStarted} tone="good" />
      </td>
      <td>
        <Metric value={row.checkoutNoPayment} of={row.checkoutsStarted} tone="warn" />
      </td>
      <td>
        <Metric value={row.paymentNotCompleted} of={row.checkoutsStarted} tone="bad" />
      </td>
      <td className={styles.totalCell}>{row.checkoutsStarted.toLocaleString()}</td>
      <td className={styles.conversionCell}>
        {row.conversionPct === null ? <span className={styles.muted}>&mdash;</span> : `${row.conversionPct}%`}
      </td>
    </tr>
  )
}

export function InsightsPage() {
  const [section, setSection] = useState<'funnel' | 'traffic'>(() => new URLSearchParams(window.location.search).get('section') === 'traffic' ? 'traffic' : 'funnel')
  const changeSection = (next: 'funnel' | 'traffic') => {
    setSection(next)
    const url = new URL(window.location.href)
    if (next === 'traffic') url.searchParams.set('section', 'traffic')
    else url.searchParams.delete('section')
    window.history.replaceState(window.history.state, '', url)
  }
  return (
    <div className={pageStyles.main}>
      <h1 className={pageStyles.pageTitle}>Live Monitoring Insights</h1>
      <nav className={trafficStyles.sectionTabs} aria-label="Insights section">
        <button type="button" aria-pressed={section === 'funnel'} onClick={() => changeSection('funnel')}>Checkout funnel</button>
        <button type="button" aria-pressed={section === 'traffic'} onClick={() => changeSection('traffic')}>Traffic counts</button>
      </nav>
      {section === 'funnel' ? <CheckoutFunnel /> : <TrafficCountsPanel />}
    </div>
  )
}

/** Unmounted when Traffic counts is active so the production SQL funnel is not polled. */
function CheckoutFunnel() {
  const [minutes, setMinutes] = useState(180)
  const [customValue, setCustomValue] = useState('')
  const [refreshMs, setRefreshMs] = useState(30_000)
  const query = useInsightsFunnelQuery(minutes, refreshMs)
  const data = query.data

  const applyCustom = () => {
    const hours = Number(customValue)
    if (!Number.isFinite(hours) || hours <= 0) return
    // The backend clamps to 5 minutes .. 7 days; mirroring it here keeps the control honest
    // rather than letting someone type 999 and quietly get a week.
    setMinutes(Math.max(5, Math.min(Math.round(hours * 60), 7 * 24 * 60)))
  }

  const totals = (data?.rows ?? []).reduce(
    (acc, r) => ({
      orders: acc.orders + r.ordersPlaced,
      noPay: acc.noPay + r.checkoutNoPayment,
      payNotDone: acc.payNotDone + r.paymentNotCompleted,
      started: acc.started + r.checkoutsStarted,
    }),
    { orders: 0, noPay: 0, payNotDone: 0, started: 0 },
  )

  return (
    <>
      <p className={styles.intro}>
        Production checkout funnel for Magrabi and DoctorM. Saleor removes a checkout once its order
        is placed, so every checkout still counted here is one that never became an order.
      </p>

      <div className={styles.controls}>
        <label className={styles.controlLabel}>
          Time window
          <select
            className={styles.select}
            value={PRESETS.some((p) => p.minutes === minutes) ? minutes : ''}
            onChange={(e) => e.target.value && setMinutes(Number(e.target.value))}
          >
            {!PRESETS.some((p) => p.minutes === minutes) && (
              <option value="">Custom &mdash; {describeWindow(minutes)}</option>
            )}
            {PRESETS.map((p) => (
              <option key={p.minutes} value={p.minutes}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.controlLabel}>
          Custom (hours)
          <span className={styles.customRow}>
            <input
              className={styles.input}
              type="number"
              min={0.1}
              step={0.5}
              placeholder="e.g. 8"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCustom()
              }}
            />
            <button type="button" className={styles.applyButton} onClick={applyCustom}>
              Apply
            </button>
          </span>
        </label>

        <label className={styles.controlLabel}>
          Auto refresh
          <select
            className={styles.select}
            value={refreshMs}
            onChange={(e) => setRefreshMs(Number(e.target.value))}
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <span className={styles.spacer} />

        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {data && !data.configured && (
        <div className={styles.notice}>
          <strong>Not connected to the production order database yet.</strong>
          <p>{data.detail}</p>
        </div>
      )}

      {query.isError && (
        <div className={styles.error}>Could not load the funnel. {(query.error as Error)?.message}</div>
      )}

      {data?.configured && data.error && <div className={styles.error}>{data.error}</div>}

      {data?.ok && (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th scope="col">
                  Orders placed
                  <span className={styles.colHint}>completed in the window</span>
                </th>
                <th scope="col">
                  Reached checkout, no payment
                  <span className={styles.colHint}>never started paying</span>
                </th>
                <th scope="col">
                  Payment started, not completed
                  <span className={styles.colHint}>payment attempted, no order</span>
                </th>
                <th scope="col">
                  Entered checkout
                  <span className={styles.colHint}>all three combined</span>
                </th>
                <th scope="col">
                  Conversion
                  <span className={styles.colHint}>orders ÷ entered</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <BrandRow key={r.brand} row={r} />
              ))}
            </tbody>
            {data.rows.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">Both brands</th>
                  <td>{totals.orders.toLocaleString()}</td>
                  <td>{totals.noPay.toLocaleString()}</td>
                  <td>{totals.payNotDone.toLocaleString()}</td>
                  <td>{totals.started.toLocaleString()}</td>
                  <td>
                    {totals.started > 0
                      ? `${((totals.orders * 100) / totals.started).toFixed(1)}%`
                      : '—'}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>

          <p className={styles.footnote}>
            Window: {describeWindow(data.minutes)}
            {data.generatedAt && <> &middot; read at {new Date(data.generatedAt).toLocaleTimeString()}</>}
            {data.cached && <> &middot; cached</>}
          </p>
        </>
      )}

      {query.isLoading && <p className={styles.muted}>Loading…</p>}
    </>
  )
}
