/** Aggregate-only traffic contract. No client identity or request payload enters this view. */
export type TrafficTimezone = 'Asia/Kolkata' | 'UTC'
export type Granularity = 'exact_status' | 'status_group'
export type ReportStatus = 'running' | 'complete' | 'partial' | 'failed'
export type SourceStatus = 'pending' | 'running' | 'complete' | 'partial' | 'unavailable'
export interface TrafficSource {
  id: string; label: string; layer: string; url: string; notes: string[]
  granularity: Granularity; configured: boolean
}
export interface TrafficCatalog {
  sources: TrafficSource[]; maxDays: number; retentionDays: number
  timezones: TrafficTimezone[]; filterVersion: string
}
export interface TrafficRow {
  scope: string; trafficClass?: string; total: number | null
  counts: Record<string, number | null>; unclassified: number | null
}
export interface TrafficSourceResult extends Omit<TrafficSource, 'configured'> {
  status: SourceStatus; coverage: { expected: number | null; observed: number | null }
  cachedChunks?: number; fetchedAt?: string; oldestFetchedAt?: string; newestFetchedAt?: string; error?: string
  totals: TrafficRow[]; daily: { date: string; rows: TrafficRow[]; status?: SourceStatus;
    coverage?: { expected: number | null; observed: number | null } }[]
}
export interface TrafficRange { start: string; end: string; timezone: TrafficTimezone }
export interface TrafficReport {
  id: string; status: ReportStatus; range: TrafficRange; generatedAt: string | null
  progress: { completed: number; total: number }; sources: TrafficSourceResult[]
  error?: string; cached?: boolean
}
export interface TrafficTicket { id: string; status: ReportStatus; cached: boolean }
export interface TrafficInput extends TrafficRange { sources: string[] }

const SOURCE_IDS = new Set(['frontdoor_main', 'ecom_cdn', 'ecom_ingress', 'macula_gateway', 'filtered_storefront'])
const REPORT_STATES = new Set<ReportStatus>(['running', 'complete', 'partial', 'failed'])
const SOURCE_STATES = new Set<SourceStatus>(['pending', 'running', 'complete', 'partial', 'unavailable'])
const CODE = /^(?:[1-5][0-9]{2}|[1-5]xx|0|Unclassified)$/
const OFFSET_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const REPORT_ID = /^[A-Za-z0-9_-]{1,96}$/
const fail = (): never => { throw new Error('Traffic response could not be validated.') }
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail()
const text = (x: unknown, max = 500): string => typeof x === 'string' && x.length <= max ? x : fail()
const count = (x: unknown): number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : fail()
const nullableCount = (x: unknown): number | null => x === null ? null : count(x)
const list = (x: unknown, max: number): unknown[] => Array.isArray(x) && x.length <= max ? x : fail()
const iso = (x: unknown): string => typeof x === 'string' && OFFSET_DATE.test(x) && Number.isFinite(Date.parse(x)) ? x : fail()
export const isReportId = (x: unknown): x is string => typeof x === 'string' && REPORT_ID.test(x)
const id = (x: unknown): string => isReportId(x) ? x : fail()
const zone = (x: unknown): TrafficTimezone => x === 'UTC' || x === 'Asia/Kolkata' ? x : fail()
const status = (x: unknown): ReportStatus => REPORT_STATES.has(x as ReportStatus) ? x as ReportStatus : fail()
const granularity = (x: unknown): Granularity => x === 'exact_status' || x === 'status_group' ? x : fail()
function decodeCoverage(raw: unknown) {
  const value = object(raw), expected = nullableCount(value.expected), observed = nullableCount(value.observed)
  if (expected !== null && observed !== null && observed > expected) fail()
  return { expected, observed }
}
function sourceBase(x: unknown) {
  const r = object(x), sourceId = text(r.id)
  if (!SOURCE_IDS.has(sourceId)) fail()
  return { id: sourceId, label: text(r.label, 120), layer: text(r.layer, 120), url: text(r.url, 4096),
    notes: list(r.notes, 40).map(x => text(x, 2000)), granularity: granularity(r.granularity) }
}
export function decodeCatalog(raw: unknown): TrafficCatalog {
  const r = object(raw)
  const sources = list(r.sources, 5).map(x => {
    const value = object(x)
    if (typeof value.configured !== 'boolean') fail()
    return { ...sourceBase(value), configured: value.configured as boolean }
  })
  if (new Set(sources.map(s => s.id)).size !== sources.length) fail()
  const maxDays = count(r.maxDays), retentionDays = count(r.retentionDays)
  if (maxDays < 1 || maxDays > 7 || retentionDays < maxDays || retentionDays > 93) fail()
  const timezones = list(r.timezones, 2).map(zone)
  if (!timezones.length) fail()
  return { sources, maxDays, retentionDays, timezones, filterVersion: text(r.filterVersion, 60) }
}
function decodeRow(raw: unknown): TrafficRow {
  const r = object(raw), entries = Object.entries(object(r.counts))
  if (entries.length > 510) fail()
  const counts: Record<string, number | null> = Object.create(null)
  for (const [key, value] of entries) {
    if (!CODE.test(key)) fail()
    counts[key] = nullableCount(value)
  }
  return { scope: text(r.scope, 200), ...(r.trafficClass === undefined ? {} : { trafficClass: text(r.trafficClass, 120) }),
    total: nullableCount(r.total), counts, unclassified: nullableCount(r.unclassified) }
}
export function decodeTicket(raw: unknown): TrafficTicket {
  const r = object(raw)
  if (typeof r.cached !== 'boolean') fail()
  return { id: id(r.id), status: status(r.status), cached: r.cached as boolean }
}
export function decodeReport(raw: unknown, expectedId?: string): TrafficReport {
  const r = object(raw), reportId = id(r.id), range = object(r.range), progress = object(r.progress)
  if (expectedId && reportId !== expectedId) fail()
  const start = iso(range.start), end = iso(range.end)
  if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > 7 * 86400000) fail()
  const sources = list(r.sources, 5).map(x => {
    const value = object(x), coverage = decodeCoverage(value.coverage)
    if (!SOURCE_STATES.has(value.status as SourceStatus)) fail()
    const base = sourceBase(value)
    const totals = list(value.totals, 1000).map(decodeRow)
    const daily = list(value.daily, 8).map(d => {
      const day = object(d), date = text(day.date, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))) fail()
      if (day.status !== undefined && !SOURCE_STATES.has(day.status as SourceStatus)) fail()
      return { date, rows: list(day.rows, 1000).map(decodeRow),
        ...(day.status === undefined ? {} : { status: day.status as SourceStatus }),
        ...(day.coverage === undefined ? {} : { coverage: decodeCoverage(day.coverage) }) }
    })
    const oldestFetchedAt = value.oldestFetchedAt == null ? undefined : iso(value.oldestFetchedAt)
    const newestFetchedAt = value.newestFetchedAt == null ? undefined : iso(value.newestFetchedAt)
    if (oldestFetchedAt && newestFetchedAt && Date.parse(oldestFetchedAt) > Date.parse(newestFetchedAt)) fail()
    return { ...base, status: value.status as SourceStatus, coverage, totals, daily,
      ...(value.cachedChunks == null ? {} : { cachedChunks: count(value.cachedChunks) }),
      ...(value.fetchedAt == null ? {} : { fetchedAt: iso(value.fetchedAt) }),
      ...(oldestFetchedAt ? { oldestFetchedAt } : {}), ...(newestFetchedAt ? { newestFetchedAt } : {}),
      ...(value.error == null ? {} : { error: text(value.error, 80) }) }
  })
  if (new Set(sources.map(s => s.id)).size !== sources.length) fail()
  const completed = count(progress.completed), total = count(progress.total)
  if (completed > total) fail()
  return { id: reportId, status: status(r.status), range: { start, end, timezone: zone(range.timezone) },
    generatedAt: r.generatedAt == null ? null : iso(r.generatedAt), progress: { completed, total }, sources,
    ...(r.error == null ? {} : { error: text(r.error, 1000) }), ...(typeof r.cached === 'boolean' ? { cached: r.cached } : {}) }
}

/** Only fixed operational sites can become links. Provider strings never become arbitrary URLs. */
export function safeSourceUrl(value: string): string | null {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      ['portal.azure.com', 'ecom-grafana.test-magrabi.com'].includes(u.hostname) ? u.href : null
  } catch { return null }
}
export const countLabel = (n: number | null | undefined): string => n == null ? '—' : n.toLocaleString('en-US')
export function classLabel(value: string | undefined): string {
  if (!value) return 'All recorded traffic'
  return value.replaceAll('_', ' ').replaceAll('-', ' ').replace(/^./, s => s.toUpperCase())
}
/** Provider diagnostics are safe codes, not messages to echo into the UI. */
export function sourceErrorMessage(code: string | undefined): string | null {
  if (!code) return null
  const messages: Record<string, string> = {
    auth: 'Authentication to this source failed.',
    authentication_failed: 'Authentication to this source failed.',
    access_denied: 'The configured account does not have access to this source.',
    source_not_configured: 'This source has not been connected on the server.',
    log_data_missing: 'No retained log data was returned for part or all of this window; this is not proof of zero traffic.',
  }
  return Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : 'Unable to query this source.'
}
export function sourceReadLabel(source: Pick<TrafficSourceResult, 'fetchedAt' | 'oldestFetchedAt' | 'newestFetchedAt' | 'cachedChunks'>): string | null {
  const newest = source.newestFetchedAt ?? source.fetchedAt, oldest = source.oldestFetchedAt
  const date = (value: string) => `${new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false })} UTC`
  const parts: string[] = []
  if (newest) parts.push(`Last source read ${date(newest)}`)
  if (oldest && newest && Date.parse(oldest) !== Date.parse(newest)) parts.push(`oldest contributing read ${date(oldest)}`)
  if (source.cachedChunks !== undefined) parts.push(`${countLabel(source.cachedChunks)} chunks reused from cache (up to 1h for historical data / 5m for recent data)`)
  return parts.length ? parts.join(' · ') : null
}
function sumPresent(row: TrafficRow, predicate: (key: string) => boolean): number | null {
  if (row.total === null) return null
  const values = Object.entries(row.counts).filter(([key]) => predicate(key)).map(([, value]) => value)
  if (values.some(v => v === null)) return null
  return (values as number[]).reduce((a, b) => a + b, 0)
}
export interface SummaryCounts { total: number | null; http200: number | null; other2xx: number | null;
  group2xx: number | null; group3xx: number | null; group4xx: number | null; group5xx: number | null; other: number | null }
export function summaryCounts(row: TrafficRow, mode: Granularity): SummaryCounts {
  const group = (prefix: string) => mode === 'status_group'
    ? row.total === null ? null : row.counts[prefix + 'xx'] ?? null
    : sumPresent(row, key => /^[1-5][0-9]{2}$/.test(key) && key.startsWith(prefix))
  const otherCodes = sumPresent(row, key => mode === 'exact_status' ? !/^[2-5][0-9]{2}$/.test(key) && key !== 'Unclassified'
    : key === '1xx' || key === '0')
  return { total: row.total, http200: mode === 'status_group' || row.total === null ? null : row.counts['200'] === undefined ? 0 : row.counts['200'],
    other2xx: mode === 'status_group' ? null : sumPresent(row, key => /^2[0-9]{2}$/.test(key) && key !== '200'),
    group2xx: group('2'), group3xx: group('3'), group4xx: group('4'), group5xx: group('5'),
    other: otherCodes === null || row.unclassified === null ? null : otherCodes + row.unclassified }
}
export function dateInput(utc: number, timezone: TrafficTimezone): string {
  return new Date(utc + (timezone === 'Asia/Kolkata' ? 19800000 : 0)).toISOString().slice(0, 16)
}
export function inputToIso(value: string, timezone: TrafficTimezone): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose both a date and a time.')
  const parsed = Date.parse(value + (timezone === 'Asia/Kolkata' ? ':00+05:30' : ':00Z'))
  if (!Number.isFinite(parsed) || dateInput(parsed, timezone) !== value) throw new Error('Choose a valid date and time.')
  return new Date(parsed).toISOString()
}
export function presetRange(preset: '1h' | '24h' | '5days', timezone: TrafficTimezone, now = Date.now()) {
  const end = Math.floor(now / 60000) * 60000
  if (preset === '5days') {
    const midnight = inputToIso(dateInput(end, timezone).slice(0, 10) + 'T00:00', timezone)
    return { start: dateInput(Date.parse(midnight) - 5 * 86400000, timezone), end: dateInput(Date.parse(midnight), timezone) }
  }
  return { start: dateInput(end - (preset === '1h' ? 3600000 : 86400000), timezone), end: dateInput(end, timezone) }
}
export function buildInput(start: string, end: string, timezone: TrafficTimezone, sources: string[],
  maxDays = 7, retentionDays = 93, now = Date.now()): TrafficInput {
  const range = { start: inputToIso(start, timezone), end: inputToIso(end, timezone), timezone }
  const a = Date.parse(range.start), b = Date.parse(range.end)
  if (a >= b) throw new Error('The end must be later than the start.')
  if (b > now) throw new Error('Choose an end time that is not in the future.')
  if (b - a > maxDays * 86400000) throw new Error(`Choose a range of ${maxDays} days or less.`)
  if (a < now - retentionDays * 86400000) throw new Error(`Choose a start within the last ${retentionDays} days. Source retention may be shorter.`)
  if (!sources.length || sources.some(s => !SOURCE_IDS.has(s)) || new Set(sources).size !== sources.length) throw new Error('Select at least one valid source.')
  return { ...range, sources: [...sources] }
}
export function rangeLabel(range: TrafficRange): string {
  const label = range.timezone === 'Asia/Kolkata' ? 'IST (UTC+05:30)' : 'UTC'
  return `${dateInput(Date.parse(range.start), range.timezone).replace('T', ' ')} → ${dateInput(Date.parse(range.end), range.timezone).replace('T', ' ')} ${label}`
}
export function matchesRange(report: TrafficReport, input: TrafficInput): boolean {
  return Date.parse(report.range.start) === Date.parse(input.start) && Date.parse(report.range.end) === Date.parse(input.end) &&
    report.range.timezone === input.timezone && report.sources.length === input.sources.length && report.sources.every(s => input.sources.includes(s.id))
}
