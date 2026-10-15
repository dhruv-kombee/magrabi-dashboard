import { useEffect, useRef, useState } from 'react'
import type { MapHealth, MapNode, ServiceMap as ServiceMapData } from './serviceMapModel'
import { decodeServiceMap, layoutServiceMap } from './serviceMapModel'
import styles from './ServiceMap.module.css'

type Props = {
  configured: boolean
  loadMap: (signal: AbortSignal) => Promise<unknown>
  onSelectService?: (id: string) => void
}

const LABEL: Record<MapHealth, string> = {
  healthy: 'No issue observed',
  error: 'Needs attention',
  unknown: 'Unknown',
  idle: 'No recent traffic',
}

const rate = (v: number | null) =>
  v === null ? 'Unknown' : v >= 100 ? `${Math.round(v).toLocaleString()}/min` : `${v.toFixed(1)}/min`
const ms = (v: number | null) =>
  v === null ? 'Unknown' : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s` : `${Math.round(v)} ms`

/**
 * The observed call graph. Every line here was seen in a real trace, unlike the endpoint
 * dashboard's configured topology. Counted before sampling, so the rates are complete.
 */
export function ServiceMap({ configured, loadMap, onSelectService }: Props) {
  const [data, setData] = useState<ServiceMapData | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const [selected, setSelected] = useState<string | null>(null)
  const active = useRef<AbortController | null>(null)
  const lastAttempt = useRef(0)

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!configured) { setData(null); return }
    async function refresh() {
      if (document.hidden || active.current || Date.now() - lastAttempt.current < 30000) return
      const request = new AbortController()
      active.current = request
      lastAttempt.current = Date.now()
      setBusy(true)
      const timeout = setTimeout(() => request.abort(), 12000)
      try {
        const next = decodeServiceMap(await loadMap(request.signal))
        if (active.current === request && !request.signal.aborted) { setData(next); setFailed(false) }
      } catch {
        // Never keep showing a previous green picture when the read failed.
        if (active.current === request) { setFailed(true); setData(null) }
      } finally {
        clearTimeout(timeout)
        if (active.current === request) { active.current = null; setBusy(false) }
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 30000)
    const onVisible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      active.current?.abort()
      active.current = null
      lastAttempt.current = 0
    }
  }, [configured, loadMap])

  // The backend states how long its sample stays meaningful. Past that, health is unknown.
  const stale = !data || clock / 1000 >= data.valid_until || clock / 1000 - data.generated_at > 200
  const shown = (h: MapHealth): MapHealth => (stale ? 'unknown' : h)
  const graph = data ? layoutServiceMap(data) : null
  const counts = { error: 0, healthy: 0, unknown: 0, idle: 0 }
  for (const n of data?.nodes ?? []) counts[shown(n.health)]++
  // A service that only makes calls receives none, so the backend reports it unknown. On a map that
  // reads as missing telemetry when it is really where a journey begins - seen live on 2026-09-11,
  // where batch-processor drew as a grey dashed box despite being the busiest caller.
  const receives = new Set((data?.edges ?? []).map(e => e.target))
  const entryPoints = new Set((data?.edges ?? []).map(e => e.source).filter(id => !receives.has(id)))
  const focus = data?.nodes.find(n => n.id === selected) ?? null
  const touching = new Set<string>(selected ? [selected] : [])
  if (selected) for (const e of data?.edges ?? []) if (e.source === selected || e.target === selected) { touching.add(e.source); touching.add(e.target) }

  return (
    <section className={styles.map} aria-label="Observed service map">
      <div className={styles.toolbar}>
        <div>
          <h2>Service map</h2>
          <p>Observed calls, last 5 minutes. Counted before sampling, so these totals are complete.</p>
        </div>
        <div className={styles.legend} aria-hidden="true">
          <span><i className={`${styles.sw} ${styles.healthy}`} />No issue</span>
          <span><i className={`${styles.sw} ${styles.error}`} />Errors</span>
          <span><i className={`${styles.sw} ${styles.unknown}`} />Unknown</span>
          <span><i className={styles.dashed} />Database or external peer</span>
        </div>
      </div>

      {!configured && <p className={styles.notice}>The service map is not connected to this portal yet.</p>}
      {failed && <p role="alert" className={styles.notice}>The service map is unavailable. A previous picture is not being reused.</p>}
      {busy && !data && <p role="status">Reading observed calls…</p>}
      {data && data.telemetry === 'unavailable' && <p className={styles.notice}>No usable measurements were returned, so every service reads as unknown.</p>}
      {data && stale && data.telemetry === 'available' && <p className={styles.notice}>These measurements have gone stale. Health is unknown until the next refresh.</p>}
      {data && !data.nodes.length && <p className={styles.notice}>No calls have been observed in this window. Services only appear here once they report a trace.</p>}

      {data && graph && !!data.nodes.length && (
        <>
          <div className={styles.summary}>
            <span><b>{data.nodes.length}</b> services and peers</span>
            <span><b>{data.edges.length}</b> observed connections</span>
            {counts.error > 0 && <span className={styles.bad}><b>{counts.error}</b> needing attention</span>}
            {counts.unknown > 0 && <span><b>{counts.unknown}</b> unknown</span>}
          </div>

          <div className={styles.canvas} tabIndex={0} aria-label="Service map. Scroll horizontally if needed.">
            <svg width={graph.width} height={graph.height} role="img"
              aria-label={`${data.nodes.length} services, ${data.edges.length} observed connections`}>
              <defs>
                <marker id="svcmap-arrow" markerWidth="7" markerHeight="7" refX="6.5" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 Z" className={styles.arrowHead} />
                </marker>
              </defs>
              {graph.links.map(link => {
                const dim = selected !== null && !(link.source === selected || link.target === selected)
                const bad = !stale && (link.error_rate ?? 0) > 0
                return (
                  <path key={`${link.source}>${link.target}>${link.connection_type}`} d={link.path}
                    markerEnd="url(#svcmap-arrow)"
                    className={[styles.link, bad ? styles.linkBad : '', dim ? styles.dim : '',
                      link.connection_type === 'service' ? '' : styles.linkPeer].join(' ')}>
                    <title>{`${link.source} to ${link.target}: ${rate(link.calls_per_min)}, p95 ${ms(link.p95_ms)}`}</title>
                  </path>
                )
              })}
              {graph.nodes.map(node => {
                const health = shown(node.health)
                const entry = entryPoints.has(node.id) && node.calls_per_min === null
                const dim = selected !== null && !touching.has(node.id)
                return (
                  <g key={node.id} className={[styles.node, entry ? styles.entry : styles[health], dim ? styles.dim : '',
                    selected === node.id ? styles.selected : ''].join(' ')}
                    role="button" tabIndex={0}
                    aria-label={`${node.service}, ${entry ? 'starts a journey here' : LABEL[health]}, ${rate(node.calls_per_min)}`}
                    onClick={() => { setSelected(node.id === selected ? null : node.id); onSelectService?.(node.id) }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelected(node.id === selected ? null : node.id)
                        onSelectService?.(node.id)
                      }
                    }}>
                    <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={5} className={styles.box} />
                    <text x={node.x + 10} y={node.y + 19} className={styles.name}>{node.service}</text>
                    <text x={node.x + 10} y={node.y + 34} className={styles.meta}>
                      {entry ? 'starts here · sends only'
                        : node.kind === 'service' ? rate(node.calls_per_min)
                        : node.kind === 'database' ? 'database' : 'external'}
                      {!entry && node.kind === 'service' && node.p95_ms !== null ? ` · p95 ${ms(node.p95_ms)}` : ''}
                    </text>
                    {health === 'error' && (
                      <g className={styles.badge}>
                        <circle cx={node.x + node.w - 2} cy={node.y + 2} r={8} />
                        <text x={node.x + node.w - 2} y={node.y + 5.5} textAnchor="middle">!</text>
                      </g>
                    )}
                  </g>
                )
              })}
            </svg>
          </div>
          <p className={styles.hint}>
            Columns are call depth: services nothing calls sit on the left, marked "starts here" because they
            receive no traffic of their own. A dashed line is a database or an external host inferred from the
            calling service, not a workload that reports for itself. Peers the collector could not pair are not
            drawn at all.
          </p>

          {focus && <ServiceDetail node={focus} data={data} stale={stale} onClose={() => setSelected(null)} />}
          <p className={styles.hint}>
            Observed connections are evidence that a call happened, not proof of a fault. Snapshot:{' '}
            {new Date(data.generated_at * 1000).toLocaleTimeString()}.
          </p>
        </>
      )}
    </section>
  )
}

function ServiceDetail({ node, data, stale, onClose }: { node: MapNode; data: ServiceMapData; stale: boolean; onClose: () => void }) {
  const incoming = data.edges.filter(e => e.target === node.id)
  const outgoing = data.edges.filter(e => e.source === node.id)
  const health = stale ? 'unknown' : node.health
  return (
    <aside className={styles.detail} aria-label={`${node.service} detail`}>
      <div className={styles.detailHead}>
        <h3>{node.service}</h3>
        <span className={`${styles.chip} ${styles[health]}`}>{LABEL[health as MapHealth]}</span>
        <span className={styles.ns}>{node.namespace ?? (node.kind === 'database' ? 'database' : 'outside the cluster')}</span>
        <button type="button" onClick={onClose}>Clear selection</button>
      </div>
      <dl className={styles.kpis}>
        <div><dt>Received</dt><dd>{stale ? 'Unknown' : rate(node.calls_per_min)}</dd></div>
        <div><dt>Failing</dt><dd>{stale ? 'Unknown' : rate(node.failed_per_min)}</dd></div>
        <div><dt>p95</dt><dd>{stale ? 'Unknown' : ms(node.p95_ms)}</dd></div>
      </dl>
      {[['Called by', incoming, 'source'] as const, ['Calls', outgoing, 'target'] as const].map(([title, rows, side]) => (
        <div key={title}>
          <h4>{title}</h4>
          {rows.length ? (
            <ul className={styles.links}>
              {rows.map(e => (
                <li key={`${e.source}>${e.target}>${e.connection_type}`}>
                  <code>{(side === 'source' ? e.source : e.target).split('/').pop()}</code>
                  <span>{stale ? 'Unknown' : `${rate(e.calls_per_min)} · p95 ${ms(e.p95_ms)}`}</span>
                  {!stale && (e.error_rate ?? 0) > 0 && (
                    <span className={styles.bad}>{(e.error_rate! * 100).toFixed(1)}% failing</span>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className={styles.hint}>None observed in this window.</p>}
        </div>
      ))}
    </aside>
  )
}
