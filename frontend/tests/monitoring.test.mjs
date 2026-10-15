// Synthetic data only. No portal application import, HTTP server, or real telemetry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeTraceSummary } from '../src/monitoring/traceResponse.ts'
import { layoutTrace, safeGrafanaLink, spanPosition } from '../src/monitoring/traceLayout.ts'
import { lookupTrace, TraceLookupError } from '../src/monitoring/traceRequest.ts'
import { createMonitoringClient } from '../src/monitoring/client.ts'
import { decodeDashboard, connectedComponents, componentLogs, decodeTraceCandidates } from '../src/monitoring/dashboardModel.ts'
import { decodeRum, siteFor, siteSessionsLink, rating, formatVital } from '../src/monitoring/rumModel.ts'
import { JOURNEY_LANES, journeyLane, journeyStatus, journeyDuration, layoutTraceJourney } from '../src/monitoring/traceJourneyModel.ts'
import { TRAFFIC_SITES, decodeTraffic, isTrafficHost, trafficFresh } from '../src/monitoring/trafficModel.ts'
import { loadSiteTraffic, TrafficRequestError } from '../src/monitoring/trafficRequest.ts'
import { servicesByNamespace, browserServices, maxTraceNodes } from '../src/monitoring/traceScope.ts'

// Synthetic identity/Faro link regressions share the existing reviewed CI test entrypoint.
{
const id = '1'.repeat(32), uid = 'test-loki'
const newServers = [['storefront-sit', 'doctorm-storefront'], ['storefront-sit', 'doctorm-storefront-checkout'],
  ['macula-sit', 'macula-dashboard']]
const browsers = [['storefront-sit', 'magrabi-storefront-web'], ['storefront-sit', 'doctorm-storefront-web'],
  ...['retail', 'iclinic', 'rivoli', 'shodo', 'zwei'].map(n => ['storefront-retail-sit', `magrabi-${n}-web`]),
  ['saleor-sit', 'ecom-dashboard-web'], ['macula-sit', 'macula-dashboard-web']]
const node = ([namespace, service]) => ({ namespace, service })
const faro = ([namespace, service]) => `{source="faro",app_name="${service}",app_namespace="${namespace}",app_environment="sit"} |= "${id}"`
const server = namespaces => (namespaces.length === 1 ? `{namespace="${namespaces[0]}"}` : `{namespace=~"${namespaces.join('|')}"}`) + ` |= "${id}"`
function link(expressions) {
  const range = { from: '1699999880000', to: '1700000120100' }
  const panes = { logs: { datasource: uid, queries: expressions.map((expr, i) => ({ refId: String.fromCharCode(65+i),
    datasource: { type: 'loki', uid }, expr, queryType: 'range', maxLines: Math.floor(100/expressions.length) })), range },
  trace: { datasource: 'tempo-lower', queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo-lower' },
    queryType: 'traceql', query: id }], range } }
  return new URL('https://grafana-lower.test-magrabi.com/explore?' + new URLSearchParams({ schemaVersion: '1', orgId: '1', panes: JSON.stringify(panes) }))
}
function fixture(pairs) {
  const sid = i => (i+1).toString(16).padStart(16, '0')
  const nodes = pairs.map(([namespace, service]) => ({ id: `${namespace}/${service}`, namespace, service,
    span_count: 1, error_span_count: 0, observed_window_ms: 100, max_span_duration_ms: 100, span_duration_sum_ms: 100 }))
  return { schema_version: 1, trace_id: id, environment: 'sit', observed_duration_ms: 100,
    start_time_unix_nano: '1700000000000000000', end_time_unix_nano: '1700000000100000000',
    span_count: nodes.length, nodes, edges: nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id,
      evidence: 'observed_cross_service_parent_child', span_relationship_count: 1, child_error_span_count: 0 })),
    spans: nodes.map((n, i) => ({ span_id: sid(i), parent_span_id: i ? sid(i-1) : null,
      service_id: n.id, namespace: n.namespace, service: n.service, kind: 'server', duration_ms: 100,
      start_offset_ms: 0, error_observed: false })), root_span_ids: [sid(0)], error_span_ids: [],
    known_partial: false, missing_parents: [], complete_end_to_end: 'not_established' }
}

test('three newly approved server pairs decode but wrong namespaces/environments/names remain denied', () => {
  for (const [namespace, service] of newServers) {
    const browser = namespace === 'macula-sit' ? 'macula-dashboard-web' : 'doctorm-storefront-web'
    assert.equal(decodeTraceSummary(fixture([[namespace, browser], [namespace, service]]), id).nodes.length, 2)
    for (const wrong of [...Object.keys(servicesByNamespace).filter(n => n !== namespace), 'storefront-dev', 'macula-uat', 'macula-prod', '__proto__']) {
      assert.throws(() => decodeTraceSummary(fixture([[namespace, browser], [wrong, service]]), id))
    }
    for (const env of ['dev', 'uat', 'prod']) {
      assert.throws(() => decodeTraceSummary({ ...fixture([[namespace, service]]), environment: env }, id))
    }
    assert.throws(() => decodeTraceSummary(fixture([[namespace, service + '-unknown']]), id))
  }
})

test('finite trace node bound accepts all33approved pairs, not duplicated or extra resources', () => {
  const pairs = Object.entries(servicesByNamespace).flatMap(([ns, names]) => [...names].map(n => [ns, n]))
  assert.equal(maxTraceNodes, 33)
  assert.equal(decodeTraceSummary(fixture(pairs), id).nodes.length, 33)
  assert.throws(() => decodeTraceSummary(fixture([...pairs, ['macula-sit', 'unreviewed']]), id))
  assert.throws(() => decodeTraceSummary(fixture([...pairs, pairs[0]]), id))
  assert.deepEqual([...browserServices].sort(), browsers.map(p => p[1]).sort())
})

test('each browser-only trace uses exact Faro selector, never a Promtail namespace query', () => {
  for (const pair of browsers) {
    const url = link([faro(pair)])
    assert.ok(safeGrafanaLink(url.href, id, [node(pair)]))
    const input = fixture([pair]); input.log_correlation = { trace_and_logs_url: url.href }
    assert.ok(decodeTraceSummary(input, id).log_correlation.trace_and_logs_url)
    assert.equal(safeGrafanaLink(link([server([pair[0]])]).href, id, [node(pair)]), undefined)
  }
})

test('mixed traces use server query first then sorted paired browser queries with bounded total lines', () => {
  const pairs = [['storefront-sit', 'doctorm-storefront'], ...browsers]
  const expressions = [server(['storefront-sit']), ...[...browsers].sort((a,b) => a.join('/').localeCompare(b.join('/'))).map(faro)]
  const url = link(expressions)
  assert.ok(url.href.length < 12000)
  const result = safeGrafanaLink(url.href, id, pairs.map(node).reverse())
  assert.ok(result)
  const queries = JSON.parse(new URL(result).searchParams.get('panes')).logs.queries
  assert.deepEqual(queries.map(q => q.expr), expressions)
  assert.deepEqual(queries.map(q => q.refId), [...'ABCDEFGHIJ'])
  assert.equal(queries.reduce((sum, q) => sum + q.maxLines, 0), 100)
  const input = fixture(pairs); input.log_correlation = { trace_and_logs_url: result }
  assert.ok(decodeTraceSummary(input, id).log_correlation.trace_and_logs_url)
})

test('mixed same-namespace browser and server remain separate sources; repeated pairs deduplicate', () => {
  const pair = ['storefront-sit', 'doctorm-storefront-web'], srv = ['storefront-sit', 'doctorm-storefront']
  const url = link([server(['storefront-sit']), faro(pair)])
  assert.ok(safeGrafanaLink(url.href, id, [node(pair), node(srv), node(pair)]))
  assert.equal(safeGrafanaLink(link([faro(pair), server(['storefront-sit'])]).href, id, [node(pair), node(srv)]), undefined)
})

test('malformed, widened, reordered or over-budget mixed queries are discarded without raw-field leakage', () => {
  const pairs = [['macula-sit', 'macula-dashboard'], ['macula-sit', 'macula-dashboard-web'], ['storefront-sit', 'doctorm-storefront-web']]
  const expressions = [server(['macula-sit']), faro(pairs[1]), faro(pairs[2])]
  for (const mutate of [p => { p.logs.queries.pop() }, p => { p.logs.queries.push(p.logs.queries[0]) },
    p => { p.logs.queries[1].expr = p.logs.queries[1].expr.replace('app_namespace="macula-sit"', 'app_namespace=~".*"') },
    p => { p.logs.queries[1].expr = p.logs.queries[1].expr.replace('app_environment="sit"', 'app_environment="prod"') },
    p => { p.logs.queries[1].expr = p.logs.queries[1].expr.replace('macula-dashboard-web', 'doctorm-storefront-web') },
    p => { p.logs.queries[1].maxLines = 100 }, p => { p.logs.queries[1].refId = 'A' },
    p => { p.logs.queries[1].datasource.uid = 'other' }, p => { p.logs.queries[1] = null },
    p => { p.logs.queries = {} }, p => { p.trace.queries = [] }, p => { p.trace.range.from = '0' }]) {
    const url = link(expressions), panes = JSON.parse(url.searchParams.get('panes'))
    mutate(panes); url.searchParams.set('panes', JSON.stringify(panes))
    assert.equal(safeGrafanaLink(url.href, id, pairs.map(node)), undefined)
  }
  const url = link(expressions), panes = JSON.parse(url.searchParams.get('panes'))
  panes.logs.queries[2].raw = 'SYNTHETIC-PRIVATE'; panes.logs.raw = 'SYNTHETIC-PRIVATE'
  url.searchParams.set('panes', JSON.stringify(panes))
  const result = safeGrafanaLink(url.href, id, pairs.map(node))
  assert.ok(result)
  assert.equal(decodeURIComponent(result).includes('SYNTHETIC-PRIVATE'), false)
  for (const bad of [[], [null], [{ namespace: '__proto__', service: 'macula-dashboard-web' }],
    [{ namespace: 'macula-sit', service: 'unknown-web' }], [{ namespace: 'storefront-sit', service: 'macula-dashboard-web' }]]) {
    assert.equal(safeGrafanaLink(url.href, id, bad), undefined)
  }
})
}

function dashboardFixture() {
  const components = [{ id: 'storefront-sit/magrabi-storefront', namespace: 'storefront-sit', service: 'magrabi-storefront',
    deployment: 'storefront', desired: 1, ready: 1, health: 'healthy', trace_search: false },
    { id: 'saleor-sit/saleor-validator-api', namespace: 'saleor-sit', service: 'saleor-validator-api', deployment: 'saleor-validator-api',
      desired: 1, ready: 0, health: 'error', trace_search: false }]
  return { schema_version: 1, environment: 'sit', generated_at: 1788966000, health_valid_until: 1788966080,
    window_seconds: 300, mapping_verified_at: '2026-09-09', telemetry: 'available', ingress_collection: 'unknown', components,
    endpoints: [{ id: 'magrabi', name: 'Magrabi', host: 'magrabi-ui-sit.test-magrabi.com', type: 'website', health: 'error',
      requests: null, errors_4xx: null, errors_5xx: null, p95_ms: null, dependency_issue: true, component_ids: [components[0].id] }],
    edges: [{ source: 'magrabi', target: components[0].id, evidence: 'configured_route' },
      { source: components[0].id, target: components[1].id, evidence: 'configured_dependency' }] }
}

test('dashboard preserves unknown metrics and configured topology, discards raw fields', () => {
  const input = dashboardFixture(); input.token = 'example'; input.components[0].logs = 'SYNTHETIC-PRIVATE-MARKER'
  const value = decodeDashboard(input)
  assert.equal(value.endpoints[0].requests, null)
  assert.equal(Object.hasOwn(value, 'token'), false)
  assert.equal(value.ingress_collection, 'unknown')
  assert.equal(connectedComponents(value, value.endpoints[0]).length, 2)
  assert.ok(!JSON.stringify(value).includes('SYNTHETIC-PRIVATE-MARKER'))
})

test('a component may advertise trace search only inside the trace scope', () => {
  const ok = dashboardFixture()
  ok.components[1].trace_search = true          // saleor-sit is in trace scope
  assert.equal(decodeDashboard(ok).components[1].trace_search, true)
  const bad = dashboardFixture()
  bad.components[0].trace_search = true         // storefront-sit Service name is not in scope
  bad.components[0].namespace = 'storefront-retail-sit'
  bad.components[0].id = 'storefront-retail-sit/magrabi-storefront'
  assert.throws(() => decodeDashboard(bad))
})

test('dashboard rejects other environments, URL tokens, foreign graph identities and invalid lifetimes', () => {
  for (const mutate of [x => { x.environment = 'prod' }, x => { x.components[0].namespace = 'storefront-prod' },
    x => { x.endpoints[0].host += '?sig=private' }, x => { x.edges[1].target = 'foreign' },
    x => { x.edges[1].evidence = 'observed_trace' }, x => { x.components[0].namespace = 'storefront-retail-sit'
      x.components[0].id = 'storefront-retail-sit/magrabi-storefront'
      x.components[0].trace_search = true },
    x => { x.health_valid_until = x.generated_at + 1000 }, x => { x.endpoints[0].requests = NaN },
    x => { delete x.ingress_collection }, x => { x.ingress_collection = 'probably_healthy' }]) {
    const input = dashboardFixture(); mutate(input); assert.throws(() => decodeDashboard(input))
  }
})

test('configured cycles terminate and do not become observed trace edges', () => {
  const input = dashboardFixture(); input.edges.push({ source: input.components[1].id, target: input.components[0].id, evidence: 'configured_dependency' })
  const value = decodeDashboard(input); assert.equal(connectedComponents(value, value.endpoints[0]).length,2)
})

test('component logs use fixed Grafana, exact namespace and bounded deployment window', () => {
  const input = dashboardFixture(); const url = new URL(componentLogs(input.components[0], input.generated_at))
  assert.equal(url.hostname, 'grafana-lower.test-magrabi.com')
  const pane = JSON.parse(url.searchParams.get('panes')).logs
  assert.equal(Number(pane.range.to)-Number(pane.range.from),300000)
  assert.equal(pane.queries[0].expr, '{namespace="storefront-sit",pod=~"storefront-[a-z0-9]+-[a-z0-9]+"}')
  assert.equal(componentLogs({...input.components[0], deployment:'x"} |= "private'}, input.generated_at),undefined)
  assert.equal(componentLogs({...input.components[0], namespace:'prod'}, input.generated_at),undefined)
})

test('candidate trace parser exposes IDs only and rejects duplicates or wrong scope', () => {
  const value = decodeTraceCandidates({environment:'sit',traces:[{trace_id:'1'.repeat(32),rootTraceName:'SYNTHETIC-PRIVATE-MARKER'}]})
  assert.equal(JSON.stringify(value).includes('SYNTHETIC-PRIVATE-MARKER'), false)
  assert.throws(() => decodeTraceCandidates({environment:'prod',traces:[]}))
  assert.throws(() => decodeTraceCandidates({environment:'sit',traces:[{trace_id:'0'.repeat(32)}]}))
})

const id = '11111111111111111111111111111111'
function fixture() {
  const nodes = ['api-gateway', 'singlemicro'].map((service, i) => ({ id: `macula-sit/${service}`,
    namespace: 'macula-sit', service, span_count: 1, error_span_count: i,
    observed_window_ms: i ? 30 : 100, max_span_duration_ms: i ? 30 : 100, span_duration_sum_ms: i ? 30 : 100 }))
  return { schema_version: 1, trace_id: id, environment: 'sit', observed_duration_ms: 100,
    start_time_unix_nano: '1700000000000000000', end_time_unix_nano: '1700000000100000000',
    span_count: 2, nodes, edges: [{ source: nodes[0].id, target: nodes[1].id,
      evidence: 'observed_cross_service_parent_child', span_relationship_count: 1, child_error_span_count: 1 }],
    spans: nodes.map((n, i) => ({ span_id: String(i + 1).repeat(16), parent_span_id: i ? '1'.repeat(16) : null,
      service_id: n.id, service: n.service, namespace: n.namespace, kind: i ? 'client' : 'server',
      error_observed: !!i, duration_ms: i ? 30 : 100, start_offset_ms: i ? 10 : 0 })),
    root_span_ids: ['1'.repeat(16)], error_span_ids: ['2'.repeat(16)], known_partial: false,
    missing_parents: [], complete_end_to_end: 'not_established' }
}
const browserIdentities = [
  ['storefront-sit', 'magrabi-storefront-web'], ['storefront-sit', 'doctorm-storefront-web'],
  ...['retail', 'iclinic', 'rivoli', 'shodo', 'zwei'].map(name => ['storefront-retail-sit', `magrabi-${name}-web`]),
  ['saleor-sit', 'ecom-dashboard-web'], ['macula-sit', 'macula-dashboard-web'],
]
function identityFixture(namespace, service) {
  const input = fixture(), serviceId = `${namespace}/${service}`
  Object.assign(input.nodes[0], { id: serviceId, namespace, service })
  Object.assign(input.spans[0], { service_id: serviceId, namespace, service })
  input.edges[0].source = serviceId
  return input
}
test('trace journey has deterministic six-lane placement independent of response order', () => {
  assert.equal(JOURNEY_LANES.length, 6)
  const input = identityFixture('storefront-sit', 'magrabi-storefront-web')
  const before = JSON.stringify(input), result = layoutTraceJourney(input)
  assert.equal(result.nodes.find(n => n.service === 'magrabi-storefront-web').lane, 'customer')
  assert.equal(result.nodes.find(n => n.service === 'singlemicro').lane, 'outside')
  for (const namespace of ['storefront-sit', 'storefront-retail-sit']) {
    assert.equal(journeyLane({ namespace, service: 'storefront' }), 'storefront')
  }
  assert.equal(journeyLane({ namespace: 'saleor-sit', service: 'saleor-app-api' }), 'saleor')
  assert.equal(journeyLane({ namespace: 'saleor-apps-sit', service: 'checkout-app' }), 'apps-state')
  assert.equal(journeyLane({ namespace: 'ingress-basic', service: 'ingress-nginx' }), 'edge')
  assert.deepEqual(layoutTraceJourney({ ...input, nodes: [...input.nodes].reverse(), spans: [...input.spans].reverse(), edges: [] }), result)
  assert.equal(JSON.stringify(input), before)
  assert.equal(result.lanes.find(l => l.id === 'edge').count, 0)
  assert.equal(result.nodes.length, input.nodes.length)
  assert.equal(result.initialScrollLeft, 0)
  assert.equal(layoutTraceJourney(fixture()).initialScrollLeft, 1300)
})
test('journey reconstructs only observed relationships, not configured edges or missing parents', () => {
  const input = fixture()
  input.edges.push({ source: input.nodes[1].id, target: input.nodes[0].id, evidence: 'configured_dependency' })
  assert.equal(layoutTraceJourney(input).edges.length, 1)
  const result = layoutTraceJourney(input).edges[0]
  assert.equal(result.evidence, 'observed_cross_service_parent_child')
  assert.equal(result.minChildMs, 30)
  assert.equal(result.maxChildMs, 30)
  assert.equal(result.relationshipCount, 1)
  input.spans[1].parent_span_id = 'f'.repeat(16)
  assert.equal(layoutTraceJourney(input).edges.length, 0)
})
test('journey status is trace-local, errors win over slow, and unavailable values stay unknown', () => {
  const base = fixture().spans[0]
  assert.equal(journeyStatus([]), 'unknown')
  assert.equal(journeyStatus([{ ...base, duration_ms: NaN }]), 'unknown')
  assert.equal(journeyStatus([{ ...base, error_observed: undefined }]), 'unknown')
  assert.equal(journeyStatus([{ ...base, duration_ms: 3000 }]), 'no-error')
  assert.equal(journeyStatus([{ ...base, duration_ms: 3000.001 }]), 'slow')
  assert.equal(journeyStatus([{ ...base, duration_ms: 4000 }, { ...base, error_observed: true }]), 'errors')
  assert.equal(journeyDuration(null), 'Unknown')
  assert.equal(journeyDuration(NaN), 'Unknown')
  assert.equal(journeyDuration(0), '0 ms')
  const input = fixture(); input.spans = input.spans.slice(1)
  const unknown = layoutTraceJourney(input).nodes.find(n => n.id === input.nodes[0].id)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.maxSpanMs, null)
})
test('journey handles re-entrant service paths without claiming their times are additive', () => {
  const input = fixture()
  input.spans.push({ ...input.spans[0], span_id: '3'.repeat(16), parent_span_id: input.spans[1].span_id,
    start_offset_ms: 15, duration_ms: 10 })
  const graph = layoutTraceJourney(input)
  assert.equal(graph.edges.length, 2)
  assert.ok(graph.edges.every(e => !e.path.includes('NaN') && !e.path.includes('Infinity')))
  assert.equal(graph.nodes.find(n => n.id === input.nodes[0].id).maxSpanMs, 100)
})
test('trace journey renders six lanes, explicit unknowns and accessible selected trace nodes', async () => {
  // Node's native TypeScript loader does not support JSX/CSS. A scoped test-only loader compiles
  // this component in memory; no application server, files, browser or network is started.
  const { registerHooks } = await import('node:module'), { readFileSync } = await import('node:fs')
  const ts = await import('typescript'), React = await import('react'), { renderToStaticMarkup } = await import('react-dom/server')
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === './traceJourneyModel' && context.parentURL?.endsWith('/TraceJourney.tsx')) return next(specifier + '.ts', context)
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.endsWith('/TraceJourney.tsx')) return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText }
      if (url.endsWith('/TraceJourney.module.css')) return { format: 'module', shortCircuit: true,
        source: 'export default new Proxy({}, { get: (_target, key) => key })' }
      return next(url, context)
    },
  })
  try {
    const { TraceJourney } = await import('../src/monitoring/TraceJourney.tsx')
    const input = identityFixture('storefront-sit', 'magrabi-storefront-web')
    const html = renderToStaticMarkup(React.createElement(TraceJourney, { trace: input,
      selectedService: input.nodes[0].id, onSelect() {} }))
    for (const lane of JOURNEY_LANES) assert.ok(html.includes(lane.title))
    assert.ok(html.includes('aria-pressed="true"'))
    assert.ok(html.includes('Not observed'))
    assert.ok(html.includes('Timing and status unknown.'))
    assert.ok(html.includes('No configured or inferred connections are drawn.'))
    assert.ok(html.includes('child span 30 ms'))
    assert.equal(html.includes('complete end to end'), false)
  } finally { hook.deregister() }
})
function logLink() {
  const range = { from: '1699999880000', to: '1700000120100' }, uid = 'test-loki'
  const panes = { logs: { datasource: uid, queries: [{ refId: 'A', datasource: { type: 'loki', uid },
    expr: `{namespace="macula-sit"} |= "${id}"`, queryType: 'range', maxLines: 100 }], range },
  trace: { datasource: 'tempo-lower', queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo-lower' },
    queryType: 'traceql', query: id }], range } }
  return new URL('https://grafana-lower.test-magrabi.com/explore?' + new URLSearchParams({ schemaVersion: '1', orgId: '1', panes: JSON.stringify(panes) }))
}

test('valid trace keeps observed graph and drops raw/unrecognized fields', () => {
  const input = fixture()
  input.raw_logs = 'SYNTHETIC-PRIVATE-MARKER'
  input.nodes[0].sql = 'SYNTHETIC-PRIVATE-MARKER'
  input.spans[0].name = 'SYNTHETIC-PRIVATE-MARKER'
  const result = decodeTraceSummary(input, id)
  assert.equal(result.spans.length, 2)
  assert.equal(result.edges.length, 1)
  assert.equal(JSON.stringify(result).includes('SYNTHETIC-PRIVATE-MARKER'), false)
})
test('all nine browser apps and retail servers decode with exact namespace/service pairs', () => {
  assert.equal(browserIdentities.length, 9)
  const identities = [...browserIdentities,
    ...['retail', 'iclinic', 'rivoli', 'shodo', 'zwei'].map(name => ['storefront-retail-sit', `${name}-storefront`])]
  for (const [namespace, service] of identities) {
    const input = identityFixture(namespace, service)
    input.spans[0].kind = service.endsWith('-web') ? 'client' : 'server'
    input.spans[0].url = 'SYNTHETIC-PRIVATE-MARKER'
    const result = decodeTraceSummary(input, id)
    assert.equal(result.nodes[0].id, `${namespace}/${service}`)
    assert.equal(result.edges[0].source, `${namespace}/${service}`)
    assert.equal(JSON.stringify(result).includes('SYNTHETIC-PRIVATE-MARKER'), false)
  }
})
test('browser apps in a wrong namespace, non-SIT scope or unknown service fail closed', () => {
  const scopes = ['macula-sit', 'saleor-sit', 'storefront-sit', 'storefront-retail-sit']
  for (const [namespace, service] of browserIdentities) {
    for (const wrong of [...scopes.filter(n => n !== namespace), 'macula-uat', 'storefront-prod', '__proto__']) {
      assert.throws(() => decodeTraceSummary(identityFixture(wrong, service), id), /unsupported_trace_response/)
    }
    const input = identityFixture(namespace, service); input.environment = 'prod'
    assert.throws(() => decodeTraceSummary(input, id), /unsupported_trace_response/)
  }
  for (const namespace of scopes) {
    assert.throws(() => decodeTraceSummary(identityFixture(namespace, 'unknown-web'), id), /unsupported_trace_response/)
  }
  // Former flat service/namespace sets also accepted known server names in unrelated namespaces.
  assert.throws(() => decodeTraceSummary(identityFixture('storefront-sit', 'api-gateway'), id), /unsupported_trace_response/)
})
test('bad identity, scope, numbers, kinds and incomplete shape fail closed', () => {
  for (const mutate of [x => { x.environment = 'prod' }, x => { x.nodes[0].service = 'outside' },
    x => { x.nodes[0].namespace = 'macula-uat' }, x => { x.spans[0].kind = 'raw exception' },
    x => { x.observed_duration_ms = NaN }, x => { delete x.error_span_ids },
    x => { x.spans[0].start_offset_ms = -1 }, x => { x.span_count = 9 },
    x => { x.nodes[0].error_span_count = 1 }, x => { x.nodes[0].max_span_duration_ms = 5 },
    x => { x.nodes.push(x.nodes[0]) }, x => { x.spans.push(x.spans[0]) }]) {
    const input = fixture(); mutate(input)
    assert.throws(() => decodeTraceSummary(input, id), /unsupported_trace_response/)
  }
})
test('invented edges, roots, errors and cyclic spans fail closed', () => {
  for (const mutate of [x => { x.edges[0].source = x.nodes[1].id }, x => { x.edges = [] },
    x => { x.root_span_ids = [] }, x => { x.error_span_ids = [] },
    x => { x.spans[0].parent_span_id = x.spans[1].span_id }]) {
    const input = fixture(); mutate(input)
    assert.throws(() => decodeTraceSummary(input, id))
  }
})
test('inflated trace duration rejected even when all span/node data still fit', () => {
  const input = fixture(); input.observed_duration_ms = 1000000
  input.end_time_unix_nano = String(BigInt(input.start_time_unix_nano) + 1000000000000n)
  assert.throws(() => decodeTraceSummary(input, id))
})
test('missing parents are explicit, not invented service edges', () => {
  const input = fixture(); input.spans[1].parent_span_id = '3'.repeat(16)
  input.edges = []; input.known_partial = true
  input.missing_parents = [{ span_id: '2'.repeat(16), missing_parent_span_id: '3'.repeat(16) }]
  const result = decodeTraceSummary(input, id)
  assert.equal(result.known_partial, true)
  assert.equal(layoutTrace(result).edges.length, 0)
})
test('safe link is reconstructed; extra fields are discarded', () => {
  const url = logLink(), panes = JSON.parse(url.searchParams.get('panes'))
  panes.extra = 'SYNTHETIC-PRIVATE-MARKER'; panes.logs.queries[0].raw = 'SYNTHETIC-PRIVATE-MARKER'
  url.searchParams.set('panes', JSON.stringify(panes))
  const result = safeGrafanaLink(url.href, id)
  assert.ok(result)
  assert.equal(decodeURIComponent(result).includes('SYNTHETIC-PRIVATE-MARKER'), false)
})
test('wrong org, origin, trace, namespace, datasource and unbounded ranges are not links', () => {
  for (const mutate of [u => { u.hostname = 'example.invalid' }, u => { u.searchParams.set('orgId', '2') },
    u => { u.searchParams.append('orgId', '1') }, u => { u.username = 'private' }]) {
    const url = logLink(); mutate(url); assert.equal(safeGrafanaLink(url.href, id), undefined)
  }
  for (const mutate of [p => { p.logs.queries[0].expr = '{namespace="macula-prod"}' },
    p => { p.trace.queries[0].query = '2'.repeat(32) }, p => { p.trace.datasource = 'other' },
    p => { p.logs.range.to = '1700999880000' }]) {
    const url = logLink(), panes = JSON.parse(url.searchParams.get('panes'))
    mutate(panes); url.searchParams.set('panes', JSON.stringify(panes))
    assert.equal(safeGrafanaLink(url.href, id), undefined)
  }
})
test('valid links match summary time; wrong window is omitted', () => {
  const input = fixture(); input.log_correlation = { trace_and_logs_url: logLink().href }
  assert.ok(decodeTraceSummary(input, id).log_correlation.trace_and_logs_url)
  const url = logLink(), panes = JSON.parse(url.searchParams.get('panes'))
  panes.logs.range.from = panes.trace.range.from = '1699999880001'
  url.searchParams.set('panes', JSON.stringify(panes)); input.log_correlation.trace_and_logs_url = url.href
  assert.equal(decodeTraceSummary(input, id).log_correlation.trace_and_logs_url, undefined)
})
test('long trace status stays distinct from missing configuration', () => {
  const input = fixture(); input.log_correlation = { status: 'trace_window_exceeds_log_link_limit' }
  assert.equal(decodeTraceSummary(input, id).log_correlation.status, 'trace_window_exceeds_log_link_limit')
})
test('waterfall handles sub-ms and zero duration without misleading scale', () => {
  assert.deepEqual(spanPosition(0, .2, .2), { left: 0, width: 100 })
  assert.deepEqual(spanPosition(.1, .05, .2), { left: 50, width: 25 })
  assert.deepEqual(spanPosition(0, 0, 0), { left: 0, width: .4 })
})
test('service layout terminates with valid cross-service cycles', () => {
  const input = fixture(); input.edges.push({ ...input.edges[0], source: input.nodes[1].id, target: input.nodes[0].id })
  const result = layoutTrace(input)
  assert.equal(result.nodes.length, 2)
  assert.equal(result.edges.length, 2)
  assert.ok(Number.isFinite(result.width) && Number.isFinite(result.height))
})
test('successful injected lookup validates before returning', async () => {
  assert.equal((await lookupTrace(async () => fixture(), id, new AbortController())).trace_id, id)
})
test('timeout settles even when loader ignores abort forever', async () => {
  const controller = new AbortController()
  await assert.rejects(lookupTrace(() => new Promise(() => {}), id, controller, 5),
    error => error instanceof TraceLookupError && error.code === 'timed_out')
  assert.equal(controller.signal.aborted, true)
})
test('pre-cancelled requests do not invoke loader', async () => {
  const controller = new AbortController(); controller.abort()
  let called = false
  await assert.rejects(lookupTrace(async () => { called = true; return fixture() }, id, controller), /cancelled/)
  assert.equal(called, false)
})
test('cancellation discards late response; errors never echo provider messages', async () => {
  const controller = new AbortController()
  let finish
  const request = lookupTrace(() => new Promise(resolve => { finish = resolve }), id, controller)
  await Promise.resolve(); controller.abort()
  await assert.rejects(request, /cancelled/); finish(fixture())
  await assert.rejects(lookupTrace(async () => { throw new Error('SYNTHETIC-PRIVATE-MARKER') }, id, new AbortController()),
    error => error.message === 'unavailable' && !error.stack.includes('SYNTHETIC-PRIVATE-MARKER'))
})

test('same-origin API uses bounded GET requests, with no connection at construction', async () => {
  const calls = []
  const client = createMonitoringClient(async (path, options) => { calls.push({ path, options }); return Response.json(fixture()) })
  assert.equal(calls.length, 0)
  await client.trace(id, new AbortController().signal)
  assert.equal(calls[0].path, '/api/monitoring/v1/sit/traces/' + id)
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.credentials, 'same-origin')
  await assert.rejects(client.trace('../prod', new AbortController().signal), /invalid_trace_id/)
  assert.equal(calls.length, 1)
})
test('short and uppercase trace ids are padded to the canonical 32 before the request', async () => {
  const calls = []
  const client = createMonitoringClient(async (path, options) => { calls.push({ path, options }); return Response.json(fixture()) })
  await client.trace('1'.repeat(31), new AbortController().signal)
  assert.equal(calls[0].path, '/api/monitoring/v1/sit/traces/0' + '1'.repeat(31))
  await client.trace('A'.repeat(31), new AbortController().signal)
  assert.equal(calls[1].path, '/api/monitoring/v1/sit/traces/0' + 'a'.repeat(31))
  // Nothing was loosened: all-zero and over-long are still refused without a request.
  for (const bad of ['0', '0'.repeat(32), '1'.repeat(33), 'zz']) {
    await assert.rejects(client.trace(bad, new AbortController().signal), /invalid_trace_id/)
  }
  assert.equal(calls.length, 2)
})

test('the Grafana link is rebuilt with the namespaces the trace actually touched', () => {
  const ns = ['macula-sit', 'saleor-sit']
  const url = new URL(logLink().href)
  const panes = JSON.parse(url.searchParams.get('panes'))
  panes.logs.queries[0].expr = `{namespace=~"${ns.join('|')}"} |= "${id}"`
  url.searchParams.set('panes', JSON.stringify(panes))
  // With the right namespaces it validates; with the default single namespace it must not.
  assert.ok(safeGrafanaLink(url.href, id, [{ namespace: 'macula-sit', service: 'api-gateway' },
    { namespace: 'saleor-sit', service: 'saleor-app-api' }]))
  assert.equal(safeGrafanaLink(url.href, id), undefined)
})

test('unexpected environments or enabled prod are rejected', async () => {
  const envs = ['sit', 'dev', 'beta', 'prod'].map(id => ({ id, enabled: id === 'sit' }))
  const client = createMonitoringClient(async () => Response.json({ environments: envs }))
  assert.equal(await client.configured(new AbortController().signal), true)
  envs[3].enabled = true
  await assert.rejects(client.configured(new AbortController().signal), /monitoring_configuration_unavailable/)
})
test('HTTP errors and malformed/oversized response bodies are not surfaced', async () => {
  for (const response of [new Response('SYNTHETIC-PRIVATE-MARKER', { status: 403 }),
    new Response('SYNTHETIC-PRIVATE-MARKER', { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '5000001' } })]) {
    const client = createMonitoringClient(async () => response)
    await assert.rejects(client.trace(id, new AbortController().signal), error => !error.message.includes('SYNTHETIC-PRIVATE-MARKER'))
  }
})

function rumFixture() {
  return { schema_version: 1, environment: 'sit', generated_at: 1788966000, window_seconds: 3600, valid_until: 1788966060, telemetry: 'available',
    sites: [{ host: 'magrabi-ui-sit.test-magrabi.com', app: 'magrabi-storefront-web', page_loads: 318, sessions: 41, js_errors: 3,
      lcp_p75_ms: 2100.4, inp_p75_ms: 180, cls_p75: 0.041, ttfb_p75_ms: 320 },
    { host: 'magrabi-zwei-ui-sit.test-magrabi.com', app: 'magrabi-zwei-web', page_loads: null, sessions: null, js_errors: null,
      lcp_p75_ms: null, inp_p75_ms: null, cls_p75: null, ttfb_p75_ms: null }] }
}

test('rum keeps unknowns as null, drops raw fields, and rates vitals in plain words', () => {
  const input = rumFixture(); input.token = 'example'; input.sites[0].page_url = 'SYNTHETIC-PRIVATE-MARKER'
  const value = decodeRum(input)
  assert.equal(siteFor(value, 'magrabi-zwei-ui-sit.test-magrabi.com').lcp_p75_ms, null)
  assert.equal(siteFor(value, 'magrabi-zwei-ui-sit.test-magrabi.com').page_loads, null)
  assert.equal(siteFor(value, 'magrabi-zwei-ui-sit.test-magrabi.com').sessions, null)
  assert.equal(siteFor(value, 'magrabi-zwei-ui-sit.test-magrabi.com').js_errors, null)
  assert.equal(siteFor(value, 'nowhere-sit.test-magrabi.com'), undefined)
  assert.ok(!JSON.stringify(value).includes('SYNTHETIC-PRIVATE-MARKER'))
  assert.equal(Object.hasOwn(value, 'token'), false)
  assert.equal(rating('lcp_p75_ms', 2100.4), 'good'); assert.equal(rating('lcp_p75_ms', 3000), 'needs-work'); assert.equal(rating('inp_p75_ms', 600), 'poor')
  assert.equal(rating('cls_p75', null), 'unknown')
  assert.equal(formatVital('lcp_p75_ms', 2100.4), '2.1 s'); assert.equal(formatVital('inp_p75_ms', 180), '180 ms'); assert.equal(formatVital('cls_p75', 0.041), '0.04')
  assert.equal(formatVital('ttfb_p75_ms', null), 'Unknown')
})

test('rum accepts unavailable all-unknown sites without replacing them with zeros', () => {
  const input = rumFixture(); input.telemetry = 'unavailable'
  for (const site of input.sites) for (const key of Object.keys(site)) if (!['host', 'app'].includes(key)) site[key] = null
  const value = decodeRum(input)
  assert.equal(value.telemetry, 'unavailable')
  for (const site of value.sites) assert.ok(Object.entries(site).every(([key, v]) => ['host', 'app'].includes(key) || v === null))
})

test('rum rejects other environments, foreign hosts, bad numbers, duplicates and invalid lifetimes', () => {
  for (const mutate of [
    v => { v.environment = 'prod' }, v => { v.window_seconds = 300 }, v => { v.valid_until = v.generated_at + 200 },
    v => { v.sites[0].host = 'beta.magrabi.com' }, v => { v.sites[0].host = 'magrabi-ui-prod.test-magrabi.com' },
    v => { v.sites[0].app = 'Bad App' }, v => { v.sites[0].page_loads = -1 }, v => { v.sites[0].lcp_p75_ms = 'fast' },
    v => { v.sites[1].host = v.sites[0].host }, v => { v.telemetry = 'partial' }, v => { delete v.sites[0].cls_p75 },
  ]) { const v = rumFixture(); mutate(v); assert.throws(() => decodeRum(v), /unsupported_rum_response/) }
})

test('rum session link is rebuilt from validated host and app with a bounded one-hour range', () => {
  const site = decodeRum(rumFixture()).sites[0]
  const url = new URL(siteSessionsLink(site, 1788966000))
  assert.equal(url.origin + url.pathname, 'https://grafana-lower.test-magrabi.com/explore')
  const panes = JSON.parse(url.searchParams.get('panes'))
  assert.equal(panes.logs.datasource, 'P8E80F9AEF21F6940')
  assert.equal(panes.logs.queries[0].expr, '{source="faro",app_name="magrabi-storefront-web"} | logfmt | page_url=~"https://magrabi-ui-sit.test-magrabi.com/.*"')
  assert.equal(Number(panes.logs.range.to) - Number(panes.logs.range.from), 3600000)
  assert.equal(siteSessionsLink({ ...site, host: 'beta.magrabi.com' }, 1788966000), undefined)
})

test('rum client call is a bounded same-origin GET', async () => {
  const calls = []
  const client = createMonitoringClient(async (path, init) => { calls.push([path, init]); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) })
  await client.rum(new AbortController().signal)
  assert.equal(calls[0][0], '/api/monitoring/v1/sit/rum')
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].redirect, 'error')
})

const trafficHost = 'magrabi-ui-sit.test-magrabi.com'
function trafficFixture() {
  return { schema_version: 1, environment: 'sit', host: trafficHost, generated_at: 1788966000, valid_until: 1788966010,
    window_seconds: 300, window_start: 1788965700, window_end: 1788966000, telemetry: 'available',
    observation: 'retained_site_traces_only', coverage: 'incomplete', empty_reason: null,
    rows: [{ trace_id: id, at: 1788965990, kind: 'browser', route: '/products/:param', method: null,
      status: null, duration_ms: 25.5, error: null, measurement: 'selected_site_span', attribution: 'browser_reported' }] }
}
test('traffic contract preserves unknowns and self-reported attribution, drops private metadata', () => {
  assert.equal(TRAFFIC_SITES.length, 9)
  const input = trafficFixture()
  input.session_id = 'SYNTHETIC-PRIVATE-MARKER'; input.rows[0].page_url = 'SYNTHETIC-PRIVATE-MARKER'
  const result = decodeTraffic(input, trafficHost)
  assert.equal(result.rows[0].method, null)
  assert.equal(result.rows[0].status, null)
  assert.equal(result.rows[0].error, null)
  assert.equal(result.rows[0].attribution, 'browser_reported')
  assert.equal(result.rows[0].measurement, 'selected_site_span')
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC-PRIVATE-MARKER'))
  for (const bad of ['beta.magrabi.com', 'other-sit.test-magrabi.com', trafficHost + '?token=x', null]) assert.equal(isTrafficHost(bad), false)
})
test('HTTP400 traffic issue remains distinct from the graph recorded-span/5xx error policy', () => {
  const traffic = trafficFixture(); traffic.rows[0].status = 400; traffic.rows[0].error = true
  const row = decodeTraffic(traffic, trafficHost).rows[0]
  assert.equal(row.status, 400); assert.equal(row.error, true); assert.equal(row.attribution, 'browser_reported')
  const summary = decodeTraceSummary(identityFixture('storefront-sit', 'magrabi-storefront-web'), id)
  const browser = layoutTraceJourney(summary).nodes.find(n => n.service === 'magrabi-storefront-web')
  assert.equal(browser.status, 'no-error') // Not whole-service health, and not a denial of the HTTP400.
})
test('traffic rejects mismatched site/scope, false completeness, opaque routes and malformed rows', () => {
  for (const mutate of [
    x => { x.host = TRAFFIC_SITES[1].host }, x => { x.environment = 'prod' }, x => { x.coverage = 'complete' },
    x => { x.observation = 'all_requests' }, x => { x.valid_until++ }, x => { x.window_start-- },
    x => { x.rows[0].at = x.generated_at + 1 }, x => { x.rows[0].at = x.window_start - 1 },
    x => { x.rows[0].trace_id = '0'.repeat(32) }, x => { x.rows.push(x.rows[0]) },
    x => { x.rows[0].route = '/customer/secret-value' }, x => { x.rows[0].route = '/graphql?token=private' },
    x => { x.rows[0].route = '//evil.invalid' }, x => { x.rows[0].route = '/products/{customerId}' },
    x => { x.rows[0].duration_ms = Infinity }, x => { x.rows[0].status = 600 },
    x => { x.rows[0].status = 500; x.rows[0].error = false }, x => { x.rows[0].method = 'CUSTOM' },
    x => { delete x.rows[0].error }, x => { x.rows[0].attribution = 'server_reported' },
    x => { x.rows[0].measurement = 'whole_request' }, x => { x.empty_reason = 'none_attributed_or_not_yet_retained' },
    x => { x.rows = Array.from({ length: 5 }, (_, i) => ({ ...x.rows[0], trace_id: String(i + 1).repeat(32) })) },
  ]) { const input = trafficFixture(); mutate(input); assert.throws(() => decodeTraffic(input, trafficHost), /unsupported_traffic_response/) }
})
test('traffic empty lists and expired evidence never establish no traffic or live health', () => {
  const input = trafficFixture(); input.rows = []; input.empty_reason = 'none_attributed_or_not_yet_retained'
  const result = decodeTraffic(input, trafficHost)
  assert.equal(result.coverage, 'incomplete')
  assert.equal(trafficFresh(result, result.generated_at + 9), true)
  assert.equal(trafficFresh(result, result.valid_until), false)
  assert.equal(trafficFresh(result, result.generated_at - 31), false)
  assert.equal(trafficFresh(null, result.generated_at), false)
})
test('traffic client is exact-host, bounded same-origin GET; invalid sites never call fetch', async () => {
  const calls = [], client = createMonitoringClient(async (path, options) => { calls.push([path, options]); return Response.json(trafficFixture()) })
  await client.traffic(trafficHost, new AbortController().signal)
  assert.equal(calls[0][0], `/api/monitoring/v1/sit/sites/${trafficHost}/requests?window=5m`)
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].redirect, 'error')
  for (const bad of ['beta.magrabi.com', '../prod', trafficHost + '?x=y']) await assert.rejects(client.traffic(bad, new AbortController().signal))
  assert.equal(calls.length, 1)
  const oversized = createMonitoringClient(async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '20001' } }))
  await assert.rejects(oversized.traffic(trafficHost, new AbortController().signal), /monitoring_response_limit/)
})
test('traffic loader bounds timeout, ignores cancelled results and never echoes provider details', async () => {
  assert.equal((await loadSiteTraffic(async () => trafficFixture(), trafficHost, new AbortController())).host, trafficHost)
  const timeout = new AbortController()
  await assert.rejects(loadSiteTraffic(() => new Promise(() => {}), trafficHost, timeout, 5),
    error => error instanceof TrafficRequestError && error.code === 'timed_out')
  const controller = new AbortController(); let finish
  const pending = loadSiteTraffic(() => new Promise(resolve => { finish = resolve }), trafficHost, controller)
  await Promise.resolve(); controller.abort()
  await assert.rejects(pending, /cancelled/); finish(trafficFixture())
  let called = false
  await assert.rejects(loadSiteTraffic(async () => { called = true }, trafficHost, controller), /cancelled/)
  assert.equal(called, false)
  await assert.rejects(loadSiteTraffic(async () => { throw new Error('SYNTHETIC-PRIVATE-MARKER') }, trafficHost, new AbortController()),
    error => error.message === 'unavailable' && !error.stack.includes('SYNTHETIC-PRIVATE-MARKER'))
})
test('live traffic renders approved sites and safe rows with unknown status and a journey action', async () => {
  const { registerHooks } = await import('node:module'), { readFileSync } = await import('node:fs')
  const ts = await import('typescript'), React = await import('react'), { renderToStaticMarkup } = await import('react-dom/server')
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/LiveTraffic.tsx') && ['./trafficModel', './trafficRequest', './traceJourneyModel'].includes(specifier)) return next(specifier + '.ts', context)
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.endsWith('/LiveTraffic.tsx')) return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText }
      if (url.endsWith('/LiveTraffic.module.css')) return { format: 'module', shortCircuit: true,
        source: 'export default new Proxy({}, { get: (_target, key) => key })' }
      return next(url, context)
    },
  })
  try {
    const { LiveTraffic, TrafficRows } = await import('../src/monitoring/LiveTraffic.tsx')
    const sites = renderToStaticMarkup(React.createElement(LiveTraffic, { configured: true, loadTraffic() {}, onTrace() {} }))
    assert.equal((sites.match(/aria-pressed="false"/g) ?? []).length, 9)
    assert.ok(sites.includes('not a complete request log'))
    const rows = renderToStaticMarkup(React.createElement(TrafficRows, { rows: decodeTraffic(trafficFixture(), trafficHost).rows, onTrace() {} }))
    assert.ok(rows.includes('Browser (self-reported)'))
    assert.ok(rows.includes('HTTP / trace issue'))
    assert.ok(rows.includes('Unknown'))
    assert.ok(rows.includes(`Open trace journey ${id}`))
    assert.ok(!rows.includes('SYNTHETIC-PRIVATE-MARKER'))
  } finally { hook.deregister() }
})

test('the Grafana trace pane must use the traceql mode Grafana 12.3 executes; the legacy traceId mode is refused', () => {
  // Grafana 12.3.1's Tempo datasource never dispatches the legacy "traceId" query group, so a link
  // built that way opens an empty pane. Verified against the v12.3.1 source on 2026-09-15.
  const traceId = 'a'.repeat(32), uid = 'P8E80F9AEF21F6940', range = { from: '1699999880000', to: '1700000120100' }
  const panes = mode => ({
    logs: { datasource: uid, queries: [{ refId: 'A', datasource: { type: 'loki', uid }, expr: `{namespace="macula-sit"} |= "${traceId}"`,
      queryType: 'range', maxLines: 100 }], range },
    trace: { datasource: 'tempo-lower', queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo-lower' }, queryType: mode, query: traceId }], range } })
  const url = mode => 'https://grafana-lower.test-magrabi.com/explore?' + new URLSearchParams({ schemaVersion: '1', orgId: '1', panes: JSON.stringify(panes(mode)) })
  const nodes = [{ namespace: 'macula-sit', service: 'api-gateway' }]
  const good = safeGrafanaLink(url('traceql'), traceId, nodes)
  assert.ok(good)
  assert.equal(JSON.parse(new URL(good).searchParams.get('panes')).trace.queries[0].queryType, 'traceql')
  assert.equal(safeGrafanaLink(url('traceId'), traceId, nodes), undefined)
  assert.equal(safeGrafanaLink(url('traceqlSearch'), traceId, nodes), undefined)
})
