/** Deliberately small response contract: no raw labels, log text, span names or URLs. */
export type Health = 'error' | 'healthy' | 'unknown' | 'idle'
export type Component = {
  id: string; namespace: string; service: string; deployment: string | null
  ready: number | null; desired: number | null; health: Health; trace_search: boolean
}
export type Endpoint = {
  id: string; name: string; host: string; type: 'website' | 'api'; health: Health
  requests: number | null; errors_4xx: number | null; errors_5xx: number | null
  p95_ms: number | null; component_ids: string[]; dependency_issue: boolean
}
export type Dashboard = {
  schema_version: 1; environment: 'sit'; generated_at: number; health_valid_until: number; window_seconds: 300
  telemetry: 'available' | 'unavailable'; ingress_collection: 'complete' | 'unknown'; mapping_verified_at: string
  endpoints: Endpoint[]; components: Component[]
  edges: { source: string; target: string; evidence: 'configured_route' | 'configured_dependency' }[]
}
const namespaces = new Set(['macula-sit', 'saleor-sit', 'saleor-apps-sit', 'storefront-sit', 'storefront-retail-sit'])
// Namespaces whose traces the trace view will accept. Must match SIT_SERVICES in the backend
// trace model; a component may only advertise trace search if its namespace is in trace scope.
const traceScope = new Set(['macula-sit', 'saleor-sit', 'storefront-sit', 'storefront-retail-sit'])
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(v)
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12
const nullable = (v: unknown): v is number | null => v === null || number(v)
const health = (v: unknown): v is Health => ['error', 'healthy', 'unknown', 'idle'].includes(v as string)
function fail(): never { throw new Error('unsupported_dashboard_response') }
function object(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail() }

export function decodeDashboard(input: unknown): Dashboard {
  const d = object(input)
  if (d.schema_version !== 1 || d.environment !== 'sit' || d.window_seconds !== 300 || !number(d.generated_at)
    || !number(d.health_valid_until) || d.health_valid_until > (d.generated_at as number) + 121
    || !['available', 'unavailable'].includes(d.telemetry as string) || typeof d.mapping_verified_at !== 'string'
    || !['complete', 'unknown'].includes(d.ingress_collection as string)
    || !/^\d{4}-\d{2}-\d{2}$/.test(d.mapping_verified_at) || !Array.isArray(d.components) || d.components.length > 80
    || !Array.isArray(d.endpoints) || d.endpoints.length > 50 || !Array.isArray(d.edges) || d.edges.length > 200) fail()
  const ids = new Set<string>()
  const components = d.components.map(raw => {
    const c = object(raw)
    if (!namespaces.has(c.namespace as string) || !name(c.service) || c.id !== c.namespace + '/' + c.service
      || ids.has(c.id as string) || !(c.deployment === null || name(c.deployment)) || !nullable(c.ready)
      || !nullable(c.desired) || !health(c.health) || typeof c.trace_search !== 'boolean'
      || (c.trace_search && !traceScope.has(c.namespace as string))) fail()
    ids.add(c.id as string)
    return { id: c.id as string, namespace: c.namespace as string, service: c.service as string,
      deployment: c.deployment as string | null, ready: c.ready as number | null, desired: c.desired as number | null,
      health: c.health as Health, trace_search: c.trace_search as boolean }
  })
  const endpointIds = new Set<string>()
  const endpoints = d.endpoints.map(raw => {
    const e = object(raw)
    if (!name(e.id) || endpointIds.has(e.id) || typeof e.name !== 'string' || !/^[A-Za-z0-9 .&()-]{1,80}$/.test(e.name)
      || typeof e.host !== 'string' || !/^[a-z0-9-]+-sit\.test-magrabi\.com$/.test(e.host)
      || !['website', 'api'].includes(e.type as string) || !health(e.health) || !nullable(e.requests)
      || typeof e.dependency_issue !== 'boolean'
      || !nullable(e.errors_4xx) || !nullable(e.errors_5xx) || !nullable(e.p95_ms)
      || !Array.isArray(e.component_ids) || !e.component_ids.length || e.component_ids.length > 30
      || e.component_ids.some(id => !ids.has(id as string)) || new Set(e.component_ids).size !== e.component_ids.length) fail()
    endpointIds.add(e.id as string)
    return { id: e.id as string, name: e.name, host: e.host, type: e.type as Endpoint['type'], health: e.health as Health,
      requests: e.requests as number | null, errors_4xx: e.errors_4xx as number | null, errors_5xx: e.errors_5xx as number | null,
      p95_ms: e.p95_ms as number | null, component_ids: e.component_ids as string[], dependency_issue: e.dependency_issue as boolean }
  })
  const edgeIds = new Set<string>()
  const edges = d.edges.map(raw => {
    const e = object(raw), key = `${e.source}>${e.target}`
    if (!ids.has(e.target as string) || edgeIds.has(key) || e.source === e.target
      || !['configured_route', 'configured_dependency'].includes(e.evidence as string)
      || (e.evidence === 'configured_route' ? !endpointIds.has(e.source as string) : !ids.has(e.source as string))) fail()
    if (e.evidence === 'configured_route' && !endpoints.find(p => p.id === e.source)?.component_ids.includes(e.target as string)) fail()
    edgeIds.add(key)
    return { source: e.source as string, target: e.target as string, evidence: e.evidence as Dashboard['edges'][number]['evidence'] }
  })
  return { schema_version: 1, environment: 'sit', generated_at: d.generated_at as number, health_valid_until: d.health_valid_until as number, window_seconds: 300,
    telemetry: d.telemetry as Dashboard['telemetry'], ingress_collection: d.ingress_collection as Dashboard['ingress_collection'],
    mapping_verified_at: d.mapping_verified_at as string, endpoints, components, edges }
}

export function connectedComponents(d: Dashboard, endpoint: Endpoint): Component[] {
  const reachable = new Set(endpoint.component_ids)
  // Bounded traversal also handles real configured cycles without inventing a call order.
  for (let i = 0; i < d.components.length; i++) {
    const count = reachable.size
    for (const e of d.edges) if (e.evidence === 'configured_dependency' && reachable.has(e.source)) reachable.add(e.target)
    if (count === reachable.size) break
  }
  return d.components.filter(c => reachable.has(c.id))
}

export function componentLogs(c: Component, at: number): string | undefined {
  if (!namespaces.has(c.namespace) || !name(c.deployment) || !number(at)) return
  const uid = 'P8E80F9AEF21F6940', range = { from: String(Math.floor(at * 1000) - 300000), to: String(Math.floor(at * 1000)) }
  const expr = `{namespace="${c.namespace}",pod=~"${c.deployment}-[a-z0-9]+-[a-z0-9]+"}`
  const panes = { logs: { datasource: uid, queries: [{ refId: 'A', datasource: { type: 'loki', uid }, expr,
    queryType: 'range', maxLines: 100 }], range } }
  return 'https://grafana-lower.test-magrabi.com/explore?' + new URLSearchParams({ schemaVersion: '1', orgId: '1', panes: JSON.stringify(panes) })
}

export function decodeTraceCandidates(value: unknown): { trace_id: string }[] {
  const d = object(value)
  if (d.environment !== 'sit' || !Array.isArray(d.traces) || d.traces.length > 10) fail()
  const ids = new Set<string>()
  return d.traces.map(raw => {
    const t = object(raw)
    if (typeof t.trace_id !== 'string' || !/^[a-f0-9]{32}$/.test(t.trace_id) || /^0+$/.test(t.trace_id) || ids.has(t.trace_id)) fail()
    ids.add(t.trace_id)
    return { trace_id: t.trace_id }
  })
}
