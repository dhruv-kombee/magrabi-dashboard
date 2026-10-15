/** Reviewed SIT sites only. A service name alone is never sufficient host attribution. */
export const TRAFFIC_SITES = [
  { name: 'Magrabi', host: 'magrabi-ui-sit.test-magrabi.com' },
  { name: 'Doctor M', host: 'doctorm-ui-sit.test-magrabi.com' },
  { name: 'Magrabi Retail', host: 'magrabi-retail-ui-sit.test-magrabi.com' },
  { name: 'iClinic', host: 'magrabi-iclinic-ui-sit.test-magrabi.com' },
  { name: 'Rivoli', host: 'magrabi-rivoli-ui-sit.test-magrabi.com' },
  { name: 'Shodo', host: 'magrabi-shodo-ui-sit.test-magrabi.com' },
  { name: 'Zwei', host: 'magrabi-zwei-ui-sit.test-magrabi.com' },
  { name: 'Saleor Dashboard', host: 'ecom-dashboard-sit.test-magrabi.com' },
  { name: 'Macula Dashboard', host: 'macula-dashboard-sit.test-magrabi.com' },
] as const
export const isTrafficHost = (value: unknown): value is string => typeof value === 'string' && TRAFFIC_SITES.some(s => s.host === value)
export type TrafficRow = {
  trace_id: string; at: number; kind: 'browser' | 'server'; route: string | null
  method: string | null; status: number | null; duration_ms: number; error: boolean | null
  measurement: 'selected_site_span'; attribution: 'browser_reported' | 'server_reported'
}
export type Traffic = {
  schema_version: 1; environment: 'sit'; host: string; generated_at: number; valid_until: number
  window_seconds: 300; window_start: number; window_end: number; telemetry: 'available' | 'unavailable'
  observation: 'retained_site_traces_only'; coverage: 'incomplete'
  empty_reason: 'none_attributed_or_not_yet_retained' | null; rows: TrafficRow[]
}
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const safeSegments = new Set(['api', 'graphql', 'products', 'product', 'collections', 'collection', 'search',
  'category', 'categories', 'cart', 'checkout', 'account', 'health', 'healthz', 'ready', 'readyz', 'login',
  'ae-en', 'ae-ar', 'sa-en', 'sa-ar', 'eg-en', 'eg-ar', ':param'])
const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12
const integer = (n: unknown): n is number => number(n) && Number.isInteger(n)
function fail(): never { throw new Error('unsupported_traffic_response') }
function object(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail() }
function route(v: unknown): v is string | null {
  if (v === null || v === '/') return true
  if (typeof v !== 'string' || v.length > 512 || !v.startsWith('/') || v.endsWith('/')) return false
  const segments = v.slice(1).split('/')
  return segments.length <= 8 && segments.every(s => safeSegments.has(s))
}

/** Copy only the public, host-attributed contract. Opaque paths, raw spans and private labels fail
 *  closed or are discarded, never rendered even if the upstream body contains them. */
export function decodeTraffic(input: unknown, expectedHost: string): Traffic {
  const d = object(input)
  if (!isTrafficHost(expectedHost) || d.host !== expectedHost || d.schema_version !== 1 || d.environment !== 'sit'
    || !integer(d.generated_at) || !integer(d.valid_until) || d.valid_until !== d.generated_at + 10
    || d.window_seconds !== 300 || d.window_start !== d.generated_at - 300 || d.window_end !== d.generated_at
    || !['available', 'unavailable'].includes(d.telemetry as string) || d.observation !== 'retained_site_traces_only'
    || d.coverage !== 'incomplete' || !Array.isArray(d.rows) || d.rows.length > 4
    || (d.rows.length ? d.empty_reason !== null : d.empty_reason !== 'none_attributed_or_not_yet_retained')) fail()
  const ids = new Set<string>()
  const rows: TrafficRow[] = d.rows.map(raw => {
    const r = object(raw)
    if (typeof r.trace_id !== 'string' || !/^[0-9a-f]{32}$/.test(r.trace_id) || /^0+$/.test(r.trace_id) || ids.has(r.trace_id)
      || !integer(r.at) || r.at < (d.window_start as number) || r.at > (d.window_end as number)
      || !['browser', 'server'].includes(r.kind as string) || !route(r.route)
      || !(r.method === null || typeof r.method === 'string' && methods.has(r.method))
      || !(r.status === null || integer(r.status) && r.status >= 100 && r.status <= 599)
      || !number(r.duration_ms) || !(r.error === null || typeof r.error === 'boolean')
      || r.measurement !== 'selected_site_span'
      || r.attribution !== (r.kind === 'browser' ? 'browser_reported' : 'server_reported')
      || typeof r.status === 'number' && r.status >= 400 && r.error !== true) fail()
    ids.add(r.trace_id)
    return { trace_id: r.trace_id, at: r.at as number, kind: r.kind as TrafficRow['kind'], route: r.route as string | null,
      method: r.method as string | null, status: r.status as number | null, duration_ms: r.duration_ms as number,
      error: r.error as boolean | null, measurement: 'selected_site_span', attribution: r.attribution as TrafficRow['attribution'] }
  })
  return { schema_version: 1, environment: 'sit', host: expectedHost, generated_at: d.generated_at as number,
    valid_until: d.valid_until as number, window_seconds: 300, window_start: d.window_start as number,
    window_end: d.window_end as number, telemetry: d.telemetry as Traffic['telemetry'],
    observation: 'retained_site_traces_only', coverage: 'incomplete', empty_reason: d.empty_reason as Traffic['empty_reason'],
    rows: rows.sort((a, b) => b.at - a.at || a.trace_id.localeCompare(b.trace_id, 'en')) }
}

export function trafficFresh(value: Traffic | null, nowSeconds: number): boolean {
  return !!value && number(nowSeconds) && value.generated_at <= nowSeconds + 30 && nowSeconds < value.valid_until
    && nowSeconds - value.generated_at <= 10
}
