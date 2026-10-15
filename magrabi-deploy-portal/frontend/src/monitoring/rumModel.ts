/** Real-user monitoring per website, last hour. Separate contract from the endpoint dashboard on
 *  purpose: a problem here can only hide the "Users" line, never blank the dashboard. */
export type RumSite = {
  host: string; app: string
  // Legacy key: observed TTFB measurement count, not a total page-load or unique-visitor count.
  page_loads: number | null; sessions: number | null; js_errors: number | null
  lcp_p75_ms: number | null; inp_p75_ms: number | null; cls_p75: number | null; ttfb_p75_ms: number | null
}
export type Rum = {
  schema_version: 1; environment: 'sit'; generated_at: number; window_seconds: 3600; valid_until: number
  telemetry: 'available' | 'unavailable'; sites: RumSite[]
}
const SIGNALS = ['page_loads', 'sessions', 'js_errors', 'lcp_p75_ms', 'inp_p75_ms', 'cls_p75', 'ttfb_p75_ms'] as const
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(v)
const host = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]+-sit\.test-magrabi\.com$/.test(v)
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12
const nullable = (v: unknown): v is number | null => v === null || number(v)
function fail(): never { throw new Error('unsupported_rum_response') }
function object(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail() }

export function decodeRum(input: unknown): Rum {
  const d = object(input)
  if (d.schema_version !== 1 || d.environment !== 'sit' || d.window_seconds !== 3600 || !number(d.generated_at)
    || !number(d.valid_until) || d.valid_until > (d.generated_at as number) + 121 || d.valid_until < (d.generated_at as number)
    || !['available', 'unavailable'].includes(d.telemetry as string) || !Array.isArray(d.sites) || d.sites.length > 50) fail()
  const hosts = new Set<string>()
  const sites = d.sites.map(raw => {
    const s = object(raw)
    if (!host(s.host) || hosts.has(s.host) || !name(s.app) || SIGNALS.some(k => !nullable(s[k]))) fail()
    hosts.add(s.host)
    return { host: s.host, app: s.app, page_loads: s.page_loads as number | null, sessions: s.sessions as number | null,
      js_errors: s.js_errors as number | null, lcp_p75_ms: s.lcp_p75_ms as number | null, inp_p75_ms: s.inp_p75_ms as number | null,
      cls_p75: s.cls_p75 as number | null, ttfb_p75_ms: s.ttfb_p75_ms as number | null }
  })
  return { schema_version: 1, environment: 'sit', generated_at: d.generated_at as number, window_seconds: 3600,
    valid_until: d.valid_until as number, telemetry: d.telemetry as Rum['telemetry'], sites }
}

export function siteFor(rum: Rum | null, hostName: string): RumSite | undefined {
  return rum?.sites.find(s => s.host === hostName)
}

/** Web-vital guidance thresholds (TTFB is diagnostic, not itself a Core Web Vital). */
export type Rating = 'good' | 'needs-work' | 'poor' | 'unknown'
const THRESHOLDS: Record<'lcp_p75_ms' | 'inp_p75_ms' | 'cls_p75' | 'ttfb_p75_ms', [number, number]> = {
  lcp_p75_ms: [2500, 4000], inp_p75_ms: [200, 500], cls_p75: [0.1, 0.25], ttfb_p75_ms: [800, 1800] }
export function rating(kind: keyof typeof THRESHOLDS, value: number | null): Rating {
  if (value === null) return 'unknown'
  const [good, poor] = THRESHOLDS[kind]
  return value <= good ? 'good' : value <= poor ? 'needs-work' : 'poor'
}
export function formatVital(kind: keyof typeof THRESHOLDS, value: number | null): string {
  if (value === null) return 'Unknown'
  if (kind === 'cls_p75') return value.toFixed(2)
  return value >= 1000 ? (value / 1000).toFixed(1) + ' s' : Math.round(value) + ' ms'
}

/** Grafana Explore for this site's browser records over the last hour. Same fixed origin, datasource
 *  and bounded range discipline as componentLogs; host and app are re-validated before interpolation. */
export function siteSessionsLink(site: RumSite, at: number): string | undefined {
  if (!host(site.host) || !name(site.app) || !number(at)) return
  const uid = 'P8E80F9AEF21F6940', range = { from: String(Math.floor(at * 1000) - 3600000), to: String(Math.floor(at * 1000)) }
  const expr = `{source="faro",app_name="${site.app}"} | logfmt | page_url=~"https://${site.host}/.*"`
  const panes = { logs: { datasource: uid, queries: [{ refId: 'A', datasource: { type: 'loki', uid }, expr,
    queryType: 'range', maxLines: 100 }], range } }
  return 'https://grafana-lower.test-magrabi.com/explore?' + new URLSearchParams({ schemaVersion: '1', orgId: '1', panes: JSON.stringify(panes) })
}
