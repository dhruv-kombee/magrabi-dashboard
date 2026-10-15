import type { TraceSummary, TraceNode } from './types'
import { approvedTracePair, browserServices, maxTraceNodes } from './traceScope.ts'

export function spanPosition(offset: number, duration: number, observedDuration: number) {
  if (observedDuration <= 0) return { left: 0, width: 0.4 }
  const left = Math.min(100, offset / observedDuration * 100)
  return { left, width: Math.min(100 - left, Math.max(0.4, duration / observedDuration * 100)) }
}

/** A finite, cycle-tolerant service layout. Edges are observations, never invented hops. */
export function layoutTrace(trace: TraceSummary) {
  const ids = new Set(trace.nodes.map(n => n.id))
  const roots = trace.spans.filter(s => trace.root_span_ids.includes(s.span_id)).map(s => s.service_id)
  const queue = [...new Set(roots.filter(id => ids.has(id)))]
  if (!queue.length && trace.nodes[0]) queue.push(trace.nodes[0].id)
  const depths = new Map(queue.map(id => [id, 0]))
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const edge of trace.edges) {
      if (edge.source === id && ids.has(edge.target) && !depths.has(edge.target)) {
        depths.set(edge.target, depths.get(id)! + 1)
        queue.push(edge.target)
      }
    }
  }
  const disconnectedColumn = Math.max(0, ...depths.values()) + 1
  const rows = new Map<number, number>()
  const nodes = trace.nodes.map(node => {
    const depth = depths.get(node.id) ?? disconnectedColumn
    const row = rows.get(depth) ?? 0
    rows.set(depth, row + 1)
    return { ...node, x: 24 + depth * 250, y: 48 + row * 132 }
  })
  const byId = new Map(nodes.map(n => [n.id, n]))
  const edges = trace.edges.flatMap(edge => {
    const from = byId.get(edge.source), to = byId.get(edge.target)
    if (!from || !to) return []
    const sx = from.x + 208, sy = from.y + 48, tx = to.x, ty = to.y + 48
    const path = tx > sx
      ? `M${sx},${sy} C${sx + 24},${sy} ${tx - 24},${ty} ${tx},${ty}`
      : `M${sx},${sy} C${sx + 40},${sy - 84} ${tx - 40},${ty - 84} ${tx},${ty}`
    return [{ ...edge, path }]
  })
  return { nodes, edges, width: Math.max(560, ...nodes.map(n => n.x + 240)), height: Math.max(220, ...nodes.map(n => n.y + 120)) }
}

/** Rebuild exact Faro/Promtail selectors from validated trace identity pairs. Server-only
 *  queries retain their historical expression. Browser records use Faro app labels, never
 *  Promtail namespace or suffix guesses. Link existence is not proof retained logs exist. */
export function safeGrafanaLink(value: string | undefined, traceId: string | undefined,
  nodes: readonly Pick<TraceNode, 'namespace' | 'service'>[] = [{ namespace: 'macula-sit', service: 'api-gateway' }]): string | undefined {
  if (!value || value.length > 12_000 || !traceId || !/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) return undefined
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > maxTraceNodes
    || nodes.some(n => !n || !approvedTracePair(n.namespace, n.service))) return undefined
  const namespaces = [...new Set(nodes.filter(n => !browserServices.has(n.service)).map(n => n.namespace))].sort()
  const expressions: string[] = []
  if (namespaces.length) expressions.push((namespaces.length === 1 ? `{namespace="${namespaces[0]}"}`
    : `{namespace=~"${namespaces.join('|')}"}`) + ` |= "${traceId}"`)
  const browsers = [...new Set(nodes.filter(n => browserServices.has(n.service)).map(n => `${n.namespace}/${n.service}`))].sort()
  for (const pair of browsers) {
    const [namespace, service] = pair.split('/')
    expressions.push(`{source="faro",app_name="${service}",app_namespace="${namespace}",app_environment="sit"} |= "${traceId}"`)
  }
  if (!expressions.length || expressions.length > 10) return undefined
  const maxLines = Math.floor(100 / expressions.length)
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.host !== 'grafana-lower.test-magrabi.com' || url.pathname !== '/explore'
      || url.username || url.password || url.hash) return undefined
    if ([...url.searchParams.keys()].some(k => !['panes', 'schemaVersion', 'orgId'].includes(k))) return undefined
    if (['panes', 'schemaVersion', 'orgId'].some(k => url.searchParams.getAll(k).length !== 1)
      || url.searchParams.get('schemaVersion') !== '1' || url.searchParams.get('orgId') !== '1') return undefined
    const panes = JSON.parse(url.searchParams.get('panes')!)
    const logs = panes.logs, trace = panes.trace, tquery = trace.queries[0]
    const uid = logs.datasource
    const range = logs.range
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(uid)
      || !Array.isArray(logs.queries) || logs.queries.length !== expressions.length
      || !Array.isArray(trace.queries) || trace.queries.length !== 1 || trace.datasource !== 'tempo-lower'
      || logs.queries.some((query: Record<string, unknown>, i: number) => !query || typeof query !== 'object'
        || (query.datasource as Record<string, unknown>)?.type !== 'loki'
        || (query.datasource as Record<string, unknown>)?.uid !== uid || query.refId !== String.fromCharCode(65 + i)
        || query.expr !== expressions[i] || query.queryType !== 'range' || query.maxLines !== maxLines)
      || tquery.datasource.type !== 'tempo' || tquery.datasource.uid !== 'tempo-lower' || tquery.refId !== 'A'
      || tquery.queryType !== 'traceql' || tquery.query !== traceId
      || typeof range.from !== 'string' || typeof range.to !== 'string'
      || !/^\d{1,14}$/.test(range.from) || !/^\d{1,14}$/.test(range.to)
      || Number(range.to) < Number(range.from) || Number(range.to) - Number(range.from) > 1_800_000
      || trace.range.from !== range.from || trace.range.to !== range.to) return undefined
    // Reconstruct, dropping every unrecognized field rather than forwarding arbitrary pane JSON.
    const cleanRange = { from: range.from, to: range.to }
    const clean = {
      logs: { datasource: uid, queries: expressions.map((expr, i) => ({ refId: String.fromCharCode(65 + i),
        datasource: { type: 'loki', uid }, expr, queryType: 'range', maxLines })), range: cleanRange },
      trace: { datasource: 'tempo-lower', queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo-lower' },
        queryType: 'traceql', query: traceId }], range: cleanRange },
    }
    return `https://grafana-lower.test-magrabi.com/explore?${new URLSearchParams({ schemaVersion: '1', orgId: '1', panes: JSON.stringify(clean) })}`
  } catch { return undefined }
}
