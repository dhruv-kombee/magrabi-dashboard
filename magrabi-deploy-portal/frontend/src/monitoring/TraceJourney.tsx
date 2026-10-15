import { useEffect, useId, useMemo, useRef } from 'react'
import type { TraceSummary } from './types'
import { JOURNEY_CARD_WIDTH, journeyDuration, layoutTraceJourney } from './traceJourneyModel'
import styles from './TraceJourney.module.css'

type Props = { trace: TraceSummary; selectedService: string | null; onSelect: (serviceId: string | null) => void }
const statusLabels = { 'no-error': 'No error recorded', slow: 'Slow span', errors: 'Errors recorded', unknown: 'Unknown' }

/** Trace-only view: aggregate metrics and configured routes are deliberately not accepted here. */
export function TraceJourney({ trace, selectedService, onSelect }: Props) {
  const graph = useMemo(() => layoutTraceJourney(trace), [trace])
  const marker = `journey-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`, scroll = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // Macula-only traces live in the last lane. Keep their observed nodes visible initially
    // instead of opening onto five empty lanes; the browser clamps to the actual scroll width.
    if (scroll.current) scroll.current.scrollLeft = graph.initialScrollLeft
  }, [graph])
  return <section className={styles.journey} aria-label="Trace journey graph">
    <header className={styles.heading}><div><h2>Trace journey</h2><p>One retained trace, arranged by application layer.</p></div>
      <span>{trace.nodes.length} observed services · {graph.edges.length} observed connections</span></header>
    <div className={styles.legend}>
      <span className={styles.good}>No error recorded</span><span className={styles.slow}>Slow span &gt; 3 s</span>
      <span className={styles.errors}>Errors recorded</span><span>Grey = not observed / unknown</span>
      <span>Solid line = parent and child spans in this trace</span>
    </div>
    <p className={styles.hint}>No configured or inferred connections are drawn. An empty lane is not a healthy hop, and a green box is not a service health check.</p>
    <p className={styles.hint}>Graph errors mean OpenTelemetry error spans or HTTP 5xx. HTTP 4xx alone is not a graph error;
      the Live traffic list reports HTTP 4xx/5xx issues separately.</p>
    <div ref={scroll} className={styles.scroll} tabIndex={0} aria-label="Six application lanes. Scroll horizontally to follow this trace.">
      <div className={styles.canvas} style={{ width: graph.width, height: graph.height }}>
        {graph.lanes.map(lane => <div key={lane.id} className={styles.lane} style={{ left: lane.x, width: JOURNEY_CARD_WIDTH, height: graph.height - 16 }}>
          <h3>{lane.title}</h3><p>{lane.note}</p>
          {lane.count === 0 && <div className={styles.empty}><strong>Not observed</strong><span>No spans in this lane.<br />Timing and status unknown.</span></div>}
        </div>)}
        <svg className={styles.connections} width={graph.width} height={graph.height} aria-hidden="true">
          <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
          {graph.edges.map(edge => <path key={`${edge.source}>${edge.target}`} d={edge.path} markerEnd={`url(#${marker})`}
            className={`${styles.edge} ${edge.status === 'errors' ? styles.edgeError : ''} ${selectedService && edge.source !== selectedService && edge.target !== selectedService ? styles.dim : ''}`} />)}
        </svg>
        {graph.nodes.map(node => <button type="button" key={node.id} style={{ left: node.x, top: node.y, width: JOURNEY_CARD_WIDTH }}
          className={`${styles.node} ${styles[node.status]} ${selectedService && selectedService !== node.id ? styles.dim : ''}`}
          aria-pressed={selectedService === node.id} onClick={() => onSelect(selectedService === node.id ? null : node.id)}>
          <strong>{node.service}</strong><span className={styles.namespace}>{node.namespace}</span>
          <span className={styles.status}>{statusLabels[node.status]}</span>
          <span>{node.spanCount} spans · max {journeyDuration(node.maxSpanMs)}</span>
          {node.errorCount > 0 && <span>{node.errorCount} error spans</span>}
        </button>)}
      </div>
    </div>
    {graph.edges.length > 0 && <details className={styles.timings}><summary>Observed connection timings</summary>
      <ul>{graph.edges.map(edge => <li key={`${edge.source}>${edge.target}`}>
        <span><b>{edge.source.split('/')[1]}</b> → <b>{edge.target.split('/')[1]}</b></span>
        <span>{edge.relationshipCount} parent-child {edge.relationshipCount === 1 ? 'pair' : 'pairs'} · child span {edge.minChildMs === edge.maxChildMs
          ? journeyDuration(edge.maxChildMs) : `${journeyDuration(edge.minChildMs)} – ${journeyDuration(edge.maxChildMs)}`}</span>
      </li>)}</ul>
    </details>}
    {graph.edges.length === 0 && <p className={styles.hint}>No cross-service parent-child relationship was retained. No request path has been invented.</p>}
    <p className={styles.hint}>Click a box to inspect its spans below. Timings describe spans, not network transit time; overlapping spans must not be added.
      Pod readiness and browser page-load measurements are not established by this trace and remain separate.</p>
  </section>
}
