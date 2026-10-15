/**
 * Decoder for the observed service map.
 *
 * Same stance as dashboardModel: validate unknown JSON and copy only the declared contract. Node
 * and peer identities originate in application spans, so they are pattern-checked and capped here
 * as well as in the backend - a name that reaches the DOM must never be whatever a span said.
 */
export type MapHealth = 'healthy' | 'error' | 'unknown' | 'idle'
export type MapKind = 'service' | 'database' | 'external'

export type MapNode = {
  id: string; namespace: string | null; service: string; kind: MapKind
  calls_per_min: number | null; failed_per_min: number | null
  error_rate: number | null; p95_ms: number | null; health: MapHealth
}
export type MapEdge = {
  source: string; target: string; connection_type: string
  calls_per_min: number | null; failed_per_min: number | null
  error_rate: number | null; p95_ms: number | null
}
export type ServiceMap = {
  schema_version: 1; environment: 'sit'; generated_at: number; window_seconds: 300
  observation: 'observed_calls_before_sampling'
  telemetry: 'available' | 'unavailable'; valid_until: number
  nodes: MapNode[]; edges: MapEdge[]
}

const NAMESPACES = new Set(['macula-sit', 'saleor-sit', 'saleor-apps-sit', 'storefront-sit', 'storefront-retail-sit'])
const KINDS = new Set<MapKind>(['service', 'database', 'external'])
const CONNECTION_TYPES = new Set(['service', 'database', 'messaging_system', 'virtual_node'])
const HEALTHS = new Set<MapHealth>(['healthy', 'error', 'unknown', 'idle'])
const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/

function fail(): never { throw new Error('unsupported_service_map_response') }
function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail()
}
function number(v: unknown, max = 1e12): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : fail()
}
function nullable(v: unknown, max = 1e12): number | null {
  return v === null ? null : number(v, max)
}

/** Rebuild the node id the backend should have produced, rather than trusting the one it sent. */
function expectedId(namespace: string | null, service: string, kind: MapKind): string {
  return kind === 'service' ? `${namespace}/${service}` : `external/${service}`
}

export function decodeServiceMap(input: unknown): ServiceMap {
  const d = object(input)
  if (d.schema_version !== 1 || d.environment !== 'sit' || d.window_seconds !== 300
    || d.observation !== 'observed_calls_before_sampling'
    || !['available', 'unavailable'].includes(d.telemetry as string)
    || !number(d.generated_at) || !number(d.valid_until)
    || (d.valid_until as number) > (d.generated_at as number) + 181
    || !Array.isArray(d.nodes) || d.nodes.length > 60
    || !Array.isArray(d.edges) || d.edges.length > 200) fail()

  const ids = new Set<string>()
  const nodes: MapNode[] = d.nodes.map(raw => {
    const n = object(raw)
    const kind = n.kind as MapKind
    if (!KINDS.has(kind) || typeof n.service !== 'string' || !NAME.test(n.service)) fail()
    const namespace = n.namespace === null ? null : (n.namespace as string)
    if (namespace !== null && !NAMESPACES.has(namespace)) fail()
    // A service node must carry a namespace; a peer must not claim one.
    if ((kind === 'service') !== (namespace !== null)) fail()
    if (n.id !== expectedId(namespace, n.service, kind) || ids.has(n.id as string)) fail()
    if (!HEALTHS.has(n.health as MapHealth)) fail()
    ids.add(n.id as string)
    return {
      id: n.id as string, namespace, service: n.service, kind,
      calls_per_min: nullable(n.calls_per_min), failed_per_min: nullable(n.failed_per_min),
      error_rate: nullable(n.error_rate, 1), p95_ms: nullable(n.p95_ms), health: n.health as MapHealth,
    }
  })

  const seen = new Set<string>()
  const edges: MapEdge[] = d.edges.map(raw => {
    const e = object(raw), key = `${e.source}>${e.target}>${e.connection_type}`
    if (typeof e.source !== 'string' || typeof e.target !== 'string'
      || !ids.has(e.source) || !ids.has(e.target) || e.source === e.target
      || typeof e.connection_type !== 'string' || !CONNECTION_TYPES.has(e.connection_type)
      || seen.has(key)) fail()
    seen.add(key)
    const calls = nullable(e.calls_per_min), failed = nullable(e.failed_per_min)
    // Never render more failures than calls: it would read as an error rate above 100%.
    if (calls !== null && failed !== null && failed > calls) fail()
    return {
      source: e.source, target: e.target, connection_type: e.connection_type,
      calls_per_min: calls, failed_per_min: failed,
      error_rate: nullable(e.error_rate, 1), p95_ms: nullable(e.p95_ms),
    }
  })

  return {
    schema_version: 1, environment: 'sit', generated_at: d.generated_at as number,
    window_seconds: 300, observation: 'observed_calls_before_sampling',
    telemetry: d.telemetry as ServiceMap['telemetry'], valid_until: d.valid_until as number,
    nodes, edges,
  }
}

/**
 * Lay the map out in tiers, left to right, the way the estate is actually shaped: callers that
 * nothing calls sit on the left, their callees to the right, and peers (databases, external hosts)
 * fall out on the far right. Cycles are tolerated - a service that calls back is not an error.
 */
export function layoutServiceMap(map: ServiceMap, box = { w: 168, h: 46, gapX: 62, gapY: 20 }) {
  const incoming = new Map<string, number>()
  for (const n of map.nodes) incoming.set(n.id, 0)
  for (const e of map.edges) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)

  const depth = new Map<string, number>()
  const queue = map.nodes.filter(n => (incoming.get(n.id) ?? 0) === 0).map(n => n.id)
  // A map made entirely of cycles still has to render: seed from the first node.
  if (!queue.length && map.nodes.length) queue.push(map.nodes[0].id)
  for (const id of queue) depth.set(id, 0)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const e of map.edges) {
      if (e.source !== id || depth.has(e.target)) continue
      depth.set(e.target, (depth.get(id) ?? 0) + 1)
      queue.push(e.target)
    }
  }
  const orphanColumn = Math.max(0, ...depth.values()) + 1
  const rows = new Map<number, number>()
  const placed = map.nodes.map(n => {
    const column = depth.get(n.id) ?? orphanColumn
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return { ...n, x: 12 + column * (box.w + box.gapX), y: 34 + row * (box.h + box.gapY), w: box.w, h: box.h }
  })
  const byId = new Map(placed.map(n => [n.id, n]))
  const links = map.edges.flatMap(e => {
    const a = byId.get(e.source), b = byId.get(e.target)
    if (!a || !b) return []
    const forward = b.x >= a.x
    const x1 = forward ? a.x + a.w : a.x, x2 = forward ? b.x : b.x + b.w
    const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2
    const bend = Math.max(24, Math.abs(x2 - x1) / 2)
    return [{ ...e, path: `M${x1},${y1} C${x1 + (forward ? bend : -bend)},${y1} ${x2 - (forward ? bend : -bend)},${y2} ${x2},${y2}` }]
  })
  return {
    nodes: placed, links,
    width: Math.max(640, ...placed.map(n => n.x + n.w + 24)),
    height: Math.max(220, ...placed.map(n => n.y + n.h + 28)),
    columns: orphanColumn + 1,
  }
}
