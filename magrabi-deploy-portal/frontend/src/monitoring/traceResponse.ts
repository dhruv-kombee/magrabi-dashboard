import type { TraceSummary, TraceNode, TraceSpan, TraceEdge } from './types'
import { safeGrafanaLink } from './traceLayout.ts'
import { servicesByNamespace, maxTraceNodes } from './traceScope.ts'

function namespaceOf(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(servicesByNamespace, value) ? value : fail()
}
const kinds = new Set(['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'])
function fail(): never { throw new Error('unsupported_trace_response') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail()
  return value
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return fail()
  return value
}
function count(value: unknown, max = 10000): number {
  const n = number(value, max)
  if (!Number.isInteger(n)) return fail()
  return n
}
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : fail() }
function spanId(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value) ? value : fail()
}
function service(value: unknown, namespace: string): string {
  return typeof value === 'string' && servicesByNamespace[namespace].has(value) ? value : fail()
}
function unique(values: string[]): Set<string> {
  const result = new Set(values)
  if (result.size !== values.length) fail()
  return result
}
function sameIds(value: unknown, expected: string[]): string[] {
  const values = array(value, 10000).map(spanId)
  const actual = unique(values)
  if (actual.size !== expected.length || expected.some(id => !actual.has(id))) fail()
  return values
}

/** Validate unknown JSON and copy only the public UI contract, never raw payload fields. */
export function decodeTraceSummary(value: unknown, expectedId: string): TraceSummary {
  const data = record(value)
  if (!/^[0-9a-f]{32}$/.test(expectedId) || /^0+$/.test(expectedId)
    || data.schema_version !== 1 || data.environment !== 'sit' || data.trace_id !== expectedId
    || data.complete_end_to_end !== 'not_established') fail()
  const duration = number(data.observed_duration_ms)
  const nanoTime = (value: unknown) => {
    if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) return fail()
    const n = BigInt(value)
    if (n <= 0n || n > 18446744073709551615n) return fail()
    return n
  }
  const start = nanoTime(data.start_time_unix_nano), end = nanoTime(data.end_time_unix_nano)
  if (end < start || Math.abs(Number(end - start) / 1e6 - duration) > 0.000003) fail()
  const nodes: TraceNode[] = array(data.nodes, maxTraceNodes).map(value => {
    const n = record(value), ns = namespaceOf(n.namespace), name = service(n.service, ns)
    if (n.id !== `${ns}/${name}`) fail()
    return { id: n.id as string, namespace: ns, service: name,
      span_count: count(n.span_count), error_span_count: count(n.error_span_count),
      observed_window_ms: number(n.observed_window_ms), max_span_duration_ms: number(n.max_span_duration_ms),
      span_duration_sum_ms: number(n.span_duration_sum_ms) }
  })
  const nodeIds = unique(nodes.map(n => n.id))
  if (!nodes.length) fail()
  const spans: TraceSpan[] = array(data.spans, 10000).map(value => {
    const s = record(value), ns = namespaceOf(s.namespace), name = service(s.service, ns), id = `${ns}/${name}`
    if (s.service_id !== id || !nodeIds.has(id)
      || typeof s.kind !== 'string' || !kinds.has(s.kind)) fail()
    const offset = number(s.start_offset_ms), length = number(s.duration_ms)
    if (offset + length > duration + 0.000003) fail() // backend rounds nanoseconds to six decimals
    return { span_id: spanId(s.span_id), parent_span_id: s.parent_span_id === null ? null : spanId(s.parent_span_id),
      service_id: id, service: name, namespace: ns, kind: s.kind as string,
      error_observed: boolean(s.error_observed), duration_ms: length, start_offset_ms: offset }
  })
  if (!spans.length || count(data.span_count) !== spans.length) fail()
  if (Math.min(...spans.map(s => s.start_offset_ms)) !== 0
    || Math.abs(Math.max(...spans.map(s => s.start_offset_ms + s.duration_ms)) - duration) > 0.000003) fail()
  unique(spans.map(s => s.span_id))
  const byId = new Map(spans.map(s => [s.span_id, s]))
  const done = new Set<string>()
  for (const span of spans) {
    const path = new Set<string>()
    let at: TraceSpan | undefined = span
    while (at && !done.has(at.span_id)) {
      if (path.has(at.span_id)) fail()
      path.add(at.span_id)
      at = at.parent_span_id === null ? undefined : byId.get(at.parent_span_id)
    }
    for (const id of path) done.add(id)
  }
  for (const n of nodes) {
    const rows = spans.filter(s => s.service_id === n.id)
    if (!rows.length || rows.length !== n.span_count || rows.filter(s => s.error_observed).length !== n.error_span_count) fail()
    // Prevent misleading service timings from a malformed summary.
    const close = (a: number, b: number) => Math.abs(a - b) <= 0.000003 * rows.length
    if (!close(n.max_span_duration_ms, Math.max(...rows.map(s => s.duration_ms)))
      || !close(n.span_duration_sum_ms, rows.reduce((sum, s) => sum + s.duration_ms, 0))
      || !close(n.observed_window_ms, Math.max(...rows.map(s => s.start_offset_ms + s.duration_ms))
        - Math.min(...rows.map(s => s.start_offset_ms)))) fail()
  }
  const observed = new Map<string, TraceEdge>()
  for (const s of spans) {
    const parent = s.parent_span_id === null ? undefined : byId.get(s.parent_span_id)
    if (!parent || parent.service_id === s.service_id) continue
    const key = `${parent.service_id}:${s.service_id}`
    const e = observed.get(key) ?? { source: parent.service_id, target: s.service_id,
      evidence: 'observed_cross_service_parent_child' as const, span_relationship_count: 0, child_error_span_count: 0 }
    e.span_relationship_count++
    e.child_error_span_count += Number(s.error_observed)
    observed.set(key, e)
  }
  const edges: TraceEdge[] = array(data.edges, 256).map(value => {
    const e = record(value), expected = observed.get(`${e.source}:${e.target}`)
    if (!expected || e.evidence !== expected.evidence || e.span_relationship_count !== expected.span_relationship_count
      || e.child_error_span_count !== expected.child_error_span_count) fail()
    return { ...expected }
  })
  if (unique(edges.map(e => `${e.source}:${e.target}`)).size !== observed.size) fail()
  const roots = sameIds(data.root_span_ids, spans.filter(s => s.parent_span_id === null).map(s => s.span_id))
  const errors = sameIds(data.error_span_ids, spans.filter(s => s.error_observed).map(s => s.span_id))
  const missing = spans.filter(s => s.parent_span_id !== null && !byId.has(s.parent_span_id))
    .map(s => ({ span_id: s.span_id, missing_parent_span_id: s.parent_span_id! }))
  const suppliedMissing = array(data.missing_parents, 10000).map(value => {
    const m = record(value)
    return { span_id: spanId(m.span_id), missing_parent_span_id: spanId(m.missing_parent_span_id) }
  })
  const missingKeys = unique(suppliedMissing.map(m => `${m.span_id}:${m.missing_parent_span_id}`))
  if (missingKeys.size !== missing.length || missing.some(m => !missingKeys.has(`${m.span_id}:${m.missing_parent_span_id}`))) fail()
  const partial = boolean(data.known_partial)
  if (partial !== (missing.length > 0 || roots.length !== 1)) fail()
  const correlation = data.log_correlation === undefined ? undefined : record(data.log_correlation)
  let link = typeof correlation?.trace_and_logs_url === 'string' ? safeGrafanaLink(correlation.trace_and_logs_url, expectedId, nodes) : undefined
  if (link) {
    const range = JSON.parse(new URL(link).searchParams.get('panes')!).logs.range
    const from = start / 1_000_000n - 120_000n, to = (end + 999_999n) / 1_000_000n + 120_000n
    if (range.from !== String(from < 0n ? 0n : from) || range.to !== String(to)) link = undefined
  }
  const logStatus = link ? 'links_generated_not_verified'
    : correlation?.status === 'trace_window_exceeds_log_link_limit' ? 'trace_window_exceeds_log_link_limit' : 'not_configured'
  return { schema_version: 1, trace_id: expectedId, environment: 'sit', observed_duration_ms: duration,
    span_count: spans.length, nodes, edges, spans, root_span_ids: roots, error_span_ids: errors,
    missing_parents: missing, known_partial: partial, complete_end_to_end: 'not_established',
    log_correlation: { status: logStatus, logs_verified: false,
      ...(link ? { trace_and_logs_url: link } : {}) } }
}
