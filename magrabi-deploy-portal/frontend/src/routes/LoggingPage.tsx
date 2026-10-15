import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchLogStream } from '../api/client'
import {
  useLogInvocationDetailQuery,
  useLogInvocationsQuery,
  useLogSourcesQuery,
} from '../api/hooks'
import type { LogLine, LogSource } from '../api/types'
import { formatTimestamp } from '../utils/format'
import pageStyles from './Page.module.css'
import styles from './LoggingPage.module.css'

/** Application Insights severityLevel. 0 is verbose and 1 is the ordinary information line that
 * makes up almost every row, so only 2 and above are worth colouring. */
const SEVERITY = ['verbose', 'info', 'warning', 'error', 'critical'] as const

function severityClass(sev: number): string {
  if (sev >= 4) return styles.critical
  if (sev === 3) return styles.error
  if (sev === 2) return styles.warning
  return ''
}

/** Colour alone separates warning from error from critical, and three shades of red-ish is not a
 * distinction anyone should have to make by eye. The name rides in the row's tooltip instead. */
function lineTitle(l: { timestamp: string; severity: number }): string {
  return `${l.timestamp} · ${SEVERITY[l.severity] ?? `severity ${l.severity}`}`
}

/** Time only, to the second. The full timestamp is in the title attribute: a log tail is read as a
 * sequence, and repeating the date on every one of 200 rows costs width the message needs. */
function clockTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString()
}

const POLL_OPTIONS = [
  { label: 'Live (5s)', ms: 5_000 },
  { label: 'Every 15s', ms: 15_000 },
  { label: 'Paused', ms: 0 },
]

/** The live tail.
 *
 * Holds its own accumulated array rather than replacing it on each poll, because the endpoint
 * returns only what is NEW since the last line on screen -- that is what makes this a tail rather
 * than a re-render of the same window. Scroll position is left alone unless the reader is already
 * at the bottom, so reading back through history is not yanked away by the next poll.
 */
function LiveTail({ sourceKey, pollMs }: { sourceKey: string; pollMs: number }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  // Read inside the interval without making it a dependency -- otherwise every new line would
  // tear down and rebuild the timer.
  const sinceRef = useRef<string | undefined>(undefined)

  const poll = useCallback(async () => {
    try {
      const res = await fetchLogStream(sourceKey, sinceRef.current)
      setError(null)
      if (res.lines.length) {
        sinceRef.current = res.lines[res.lines.length - 1].timestamp
        // Capped so a page left open overnight cannot grow without limit.
        setLines((prev) => [...prev, ...res.lines].slice(-1000))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [sourceKey])

  // A source change starts a new tail from scratch.
  useEffect(() => {
    setLines([])
    setLoading(true)
    sinceRef.current = undefined
  }, [sourceKey])

  useEffect(() => {
    void poll()
    if (pollMs <= 0) return
    const id = window.setInterval(() => void poll(), pollMs)
    return () => window.clearInterval(id)
  }, [poll, pollMs])

  useEffect(() => {
    const box = boxRef.current
    if (box && atBottomRef.current) box.scrollTop = box.scrollHeight
  }, [lines])

  function onScroll() {
    const box = boxRef.current
    if (!box) return
    atBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  }

  return (
    <div className={styles.tailWrap}>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.tail} ref={boxRef} onScroll={onScroll} role="log" aria-live="polite">
        {loading && lines.length === 0 && <p className={styles.muted}>Loading…</p>}
        {!loading && lines.length === 0 && !error && (
          <p className={styles.muted}>
            Nothing in the last 24 hours. Register a user on the DEV site and the lines appear here.
          </p>
        )}
        {lines.map((l, i) => (
          <div key={l.id ?? `${l.timestamp}-${i}`} className={`${styles.line} ${severityClass(l.severity)}`}>
            <span className={styles.lineTime} title={lineTitle(l)}>
              {clockTime(l.timestamp)}
            </span>
            <span className={styles.lineMsg}>{l.message}</span>
          </div>
        ))}
      </div>
      <p className={styles.tailFoot}>
        {lines.length} line{lines.length === 1 ? '' : 's'} · newest at the bottom · credentials are
        removed before the log leaves the server
      </p>
    </div>
  )
}

/** One invocation, expanded: the summary row plus every line it produced, oldest first. */
function InvocationDetail({ sourceKey, invocationId }: { sourceKey: string; invocationId: string }) {
  const { data, isLoading, isError, error } = useLogInvocationDetailQuery(sourceKey, invocationId)
  if (isLoading) return <p className={styles.muted}>Loading invocation…</p>
  if (isError) return <p className={styles.error}>{(error as Error).message}</p>
  if (!data) return null
  const s = data.summary
  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <span className={s.success ? styles.pillOk : styles.pillBad}>
          {s.success ? 'Succeeded' : 'Failed'}
        </span>
        <span className={styles.detailMeta}>{formatTimestamp(s.timestamp ?? '') || '-'}</span>
        <span className={styles.detailMeta}>HTTP {s.resultCode ?? '-'}</span>
        <span className={styles.detailMeta}>
          {s.durationMs != null ? `${Math.round(s.durationMs)} ms` : '-'}
        </span>
        <code className={styles.detailId} title={data.invocationId}>
          {data.invocationId.slice(0, 16)}
        </code>
      </div>
      {data.exceptions.length > 0 && (
        <div className={styles.exceptions}>
          {data.exceptions.map((ex, i) => (
            <div key={i} className={styles.exception}>
              <strong>{ex.type}</strong> {ex.message}
            </div>
          ))}
        </div>
      )}
      <div className={styles.detailLines}>
        {data.lines.map((l, i) => (
          <div key={i} className={`${styles.line} ${severityClass(l.severity)}`}>
            <span className={styles.lineTime} title={lineTitle(l)}>
              {clockTime(l.timestamp)}
            </span>
            <span className={styles.lineMsg}>{l.message}</span>
          </div>
        ))}
        {data.lines.length === 0 && <p className={styles.muted}>No trace lines for this invocation.</p>}
      </div>
    </div>
  )
}

/** The invocation list -- the Azure portal's Invocations tab, one row per run, newest first. */
function Invocations({ sourceKey, pollMs }: { sourceKey: string; pollMs: number }) {
  const { data, isLoading, isError, error } = useLogInvocationsQuery(sourceKey, 24, pollMs)
  const [open, setOpen] = useState<string | null>(null)

  if (isLoading) return <p className={styles.muted}>Loading invocations…</p>
  if (isError) return <p className={styles.error}>{(error as Error).message}</p>
  const rows = data?.invocations ?? []
  if (rows.length === 0) return <p className={styles.muted}>No invocations in the last 24 hours.</p>

  return (
    <div className={styles.invList}>
      {rows.map((inv) => {
        const isOpen = open === inv.invocationId
        return (
          <div key={inv.invocationId} className={styles.invItem}>
            <button
              type="button"
              className={styles.invRow}
              onClick={() => setOpen(isOpen ? null : inv.invocationId)}
              aria-expanded={isOpen}
            >
              <span className={styles.invCaret} aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
              <span className={inv.success ? styles.dotOk : styles.dotBad} aria-hidden="true" />
              <span className={styles.invTime}>{formatTimestamp(inv.timestamp) || inv.timestamp}</span>
              <span className={styles.invCode}>HTTP {inv.resultCode}</span>
              <span className={styles.invDur}>{Math.round(inv.durationMs)} ms</span>
              <code className={styles.invId} title={inv.invocationId}>
                {inv.invocationId.slice(0, 12)}
              </code>
            </button>
            {isOpen && <InvocationDetail sourceKey={sourceKey} invocationId={inv.invocationId} />}
          </div>
        )
      })}
    </div>
  )
}

/** Logging Dashboard.
 *
 * Exists so a developer can read a DEV Function's logs without an Azure portal login, the right
 * subscription selected and the exact blade -- which is the real reason these logs went unread.
 * The selected tile lives in the URL so a link points at one source, the same way the status page
 * carries its environment.
 */
export function LoggingPage() {
  const [params, setParams] = useSearchParams()
  const { data, isLoading, isError, error } = useLogSourcesQuery()
  const [pollMs, setPollMs] = useState(5_000)
  const [tab, setTab] = useState<'live' | 'invocations'>('live')

  const sources: LogSource[] = data?.sources ?? []
  const selectedKey = params.get('source')
  const selected = sources.find((s) => s.key === selectedKey) ?? null

  function select(key: string | null) {
    const next = new URLSearchParams(params)
    if (key) next.set('source', key)
    else next.delete('source')
    setParams(next, { replace: true })
  }

  if (isLoading) {
    return <main className={pageStyles.main}><p className={pageStyles.loading}>Loading…</p></main>
  }
  if (isError) {
    return <main className={pageStyles.main}><p className={pageStyles.error}>{(error as Error).message}</p></main>
  }

  return (
    <main className={pageStyles.main}>
      <h1 className={styles.title}>Logging Dashboard</h1>
      <p className={styles.lede}>
        Live logs from the Azure Functions behind the sites, without needing an Azure portal login.
        Credentials — bearer tokens, basic-auth headers, anything that reads as a key — are removed
        on the server before a line is sent here.
      </p>

      {data && !data.configured && (
        <div className={styles.warn}>
          <strong>Not connected to Azure yet.</strong> The tiles below are configured, but the
          portal has no Azure Monitor credentials, so no logs can be read. A service principal with
          <em> Monitoring Reader</em> on the Application Insights resource needs to be added to the{' '}
          <code>deploy-portal-azure</code> secret.
        </div>
      )}

      {!selected && (
        <div className={styles.grid}>
          {sources.map((s) => (
            <button key={s.key} type="button" className={styles.tile} onClick={() => select(s.key)}>
              <span className={styles.tileEnv}>{s.env}</span>
              <span className={styles.tileTitle}>{s.title}</span>
              <code className={styles.tileFn}>{s.subtitle}</code>
              <span className={styles.tileDesc}>{s.description}</span>
              <span className={styles.tileGo}>Open logs →</span>
            </button>
          ))}
          {sources.length === 0 && <p className={styles.muted}>No log sources are configured.</p>}
        </div>
      )}

      {selected && (
        <>
          <div className={styles.bar}>
            <button type="button" className={styles.back} onClick={() => select(null)}>
              ← All sources
            </button>
            <div className={styles.barTitle}>
              <span className={styles.tileEnv}>{selected.env}</span>
              <strong>{selected.title}</strong>
              <code className={styles.tileFn}>{selected.subtitle}</code>
            </div>
            <div className={styles.barRight}>
              <label className={styles.pollGroup}>
                <span>Refresh</span>
                <select value={pollMs} onChange={(e) => setPollMs(Number(e.target.value))}>
                  {POLL_OPTIONS.map((o) => (
                    <option key={o.ms} value={o.ms}>{o.label}</option>
                  ))}
                </select>
              </label>
              <a className={styles.portalLink} href={selected.portalUrl} target="_blank" rel="noreferrer">
                Open in Azure
              </a>
            </div>
          </div>

          <div className={styles.tabs} role="tablist">
            <button
              type="button" role="tab" aria-selected={tab === 'live'}
              className={tab === 'live' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab('live')}
            >
              Live logs
            </button>
            <button
              type="button" role="tab" aria-selected={tab === 'invocations'}
              className={tab === 'invocations' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab('invocations')}
            >
              Invocation details
            </button>
          </div>

          {tab === 'live'
            ? <LiveTail sourceKey={selected.key} pollMs={pollMs} />
            : <Invocations sourceKey={selected.key} pollMs={pollMs} />}
        </>
      )}
    </main>
  )
}
