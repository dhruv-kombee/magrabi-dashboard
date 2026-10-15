import type { TraceNode, TraceSpan, TraceSummary } from './types'

/** Architecture lanes are presentation only, not a claim that a request crossed every lane. */
export const JOURNEY_LANES = [
  { id: 'customer', title: 'Customer', note: 'Browser spans' },
  { id: 'edge', title: 'Edge', note: 'Ingress and network' },
  { id: 'storefront', title: 'Storefront', note: 'Website services' },
  { id: 'saleor', title: 'Saleor', note: 'Commerce services' },
  { id: 'apps-state', title: 'Apps and state', note: 'Apps, databases and queues' },
  { id: 'outside', title: 'Outside the commerce path', note: 'Macula and external systems' },
] as const
export type JourneyLane = typeof JOURNEY_LANES[number]['id']
export type JourneyStatus = 'no-error' | 'slow' | 'errors' | 'unknown'
export const SLOW_SPAN_MS = 3000
export const JOURNEY_CARD_WIDTH = 220
const COLUMN = 260, TOP = 108, ROW = 170, LEFT = 20
const validMs = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function journeyLane(node: Pick<TraceNode, 'namespace' | 'service'>): JourneyLane {
  if (node.service.endsWith('-web')) return 'customer'
  if (node.namespace === 'ingress-basic') return 'edge'
  if (node.namespace === 'storefront-sit' || node.namespace === 'storefront-retail-sit') return 'storefront'
  if (node.namespace === 'saleor-apps-sit') return 'apps-state'
  if (node.namespace === 'saleor-sit') return 'saleor'
  return 'outside'
}

export function journeyStatus(spans: TraceSpan[]): JourneyStatus {
  if (!spans.length) return 'unknown'
  if (spans.some(s => s.error_observed === true)) return 'errors'
  if (spans.some(s => !validMs(s.duration_ms) || typeof s.error_observed !== 'boolean')) return 'unknown'
  return spans.some(s => s.duration_ms > SLOW_SPAN_MS) ? 'slow' : 'no-error'
}

export function journeyDuration(value: number | null): string {
  if (!validMs(value)) return 'Unknown'
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Number(value.toFixed(3))} ms`
}

/** Build from a decoded summary. Reconstruct relationships from spans again so a configured or
 *  aggregate service-map edge can never become an observed edge by being passed to this helper.
 *  Duration labels are the child span's duration, NOT network transit time or additive latency. */
export function layoutTraceJourney(trace: TraceSummary) {
  const spansByService = new Map<string, TraceSpan[]>()
  const spansById = new Map(trace.spans.map(s => [s.span_id, s]))
  for (const span of trace.spans) {
    const rows = spansByService.get(span.service_id) ?? []
    rows.push(span); spansByService.set(span.service_id, rows)
  }
  const laneRows = new Map<JourneyLane, number>()
  const nodes = [...trace.nodes].sort((a, b) => a.id.localeCompare(b.id, 'en')).map(node => {
    const lane = journeyLane(node), row = laneRows.get(lane) ?? 0
    laneRows.set(lane, row + 1)
    const spans = spansByService.get(node.id) ?? [], times = spans.map(s => s.duration_ms)
    return { id: node.id, service: node.service, namespace: node.namespace, lane,
      spanCount: spans.length, errorCount: spans.filter(s => s.error_observed === true).length,
      maxSpanMs: times.length && times.every(validMs) ? Math.max(...times) : null,
      status: journeyStatus(spans), x: LEFT + JOURNEY_LANES.findIndex(l => l.id === lane) * COLUMN, y: TOP + row * ROW }
  })
  const byId = new Map(nodes.map(n => [n.id, n]))
  const relationships = new Map<string, { source: string; target: string; children: TraceSpan[] }>()
  for (const span of trace.spans) {
    const parent = span.parent_span_id === null ? undefined : spansById.get(span.parent_span_id)
    if (!parent || parent.service_id === span.service_id || !byId.has(parent.service_id) || !byId.has(span.service_id)) continue
    const key = `${parent.service_id}>${span.service_id}`
    const edge = relationships.get(key) ?? { source: parent.service_id, target: span.service_id, children: [] }
    edge.children.push(span); relationships.set(key, edge)
  }
  const edges = [...relationships.values()].sort((a, b) => `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`, 'en')).map(edge => {
    const from = byId.get(edge.source)!, to = byId.get(edge.target)!
    const sx = from.x + JOURNEY_CARD_WIDTH, sy = from.y + 66, tx = to.x, ty = to.y + 66
    const forward = tx > sx
    const path = forward ? `M${sx},${sy} C${sx + 26},${sy} ${tx - 26},${ty} ${tx},${ty}`
      : `M${sx},${sy} C${sx + 24},${sy - 75} ${tx - 24},${ty - 75} ${tx},${ty}`
    const durations = edge.children.map(s => s.duration_ms), valid = durations.every(validMs)
    return { source: edge.source, target: edge.target, evidence: 'observed_cross_service_parent_child' as const,
      relationshipCount: edge.children.length, status: journeyStatus(edge.children), path,
      minChildMs: valid ? Math.min(...durations) : null, maxChildMs: valid ? Math.max(...durations) : null }
  })
  return { nodes, edges, lanes: JOURNEY_LANES.map((lane, i) => ({ ...lane, x: LEFT + i * COLUMN, count: laneRows.get(lane.id) ?? 0 })),
    width: JOURNEY_LANES.length * COLUMN, height: TOP + Math.max(1, ...laneRows.values()) * ROW + 20,
    initialScrollLeft: nodes.length ? Math.max(0, Math.min(...nodes.map(n => n.x)) - LEFT) : 0 }
}
