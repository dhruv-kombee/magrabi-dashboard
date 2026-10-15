/** Public, values-free synthetic contract. Never render arbitrary runner text. */
export const SYNTHETIC_STEPS = ['site', 'login', 'product', 'cart', 'shipping', 'payment', 'return', 'cleanup'] as const
export const STEP_STATUSES = ['pending', 'running', 'passed', 'failed', 'blocked', 'skipped'] as const
export const RUN_STATUSES = ['running', 'passed', 'failed', 'blocked', 'interrupted'] as const
export const REASON_CODES = ['none', 'not_configured', 'auth_failed', 'mfa_required', 'site_unavailable',
  'selector_changed', 'no_stock', 'stock_changed', 'cart_not_empty', 'cart_verification_failed',
  'shipping_failed', 'payment_boundary_not_approved', 'payment_not_reached', 'forbidden_payment_action',
  'unexpected_origin', 'step_timeout', 'run_timeout', 'cleanup_failed', 'runner_lost',
  'concurrent_run', 'internal_error', 'results_unavailable'] as const
export type SyntheticReason = typeof REASON_CODES[number]
export type SyntheticStep = {
  id: typeof SYNTHETIC_STEPS[number]; status: typeof STEP_STATUSES[number]
  duration_ms: number | null; http_status: number | null; reason_code: SyntheticReason
}
export type SyntheticRun = {
  run_id: string; site_id: 'magrabi-sit'; environment: 'sit'; scheduled_at: string
  started_at: string; finished_at: string | null; updated_at: string
  status: typeof RUN_STATUSES[number]; duration_ms: number | null; candidate_attempts: number
  payment_boundary: 'checkout_only' | 'gateway_reached'
  cleanup_status: 'not_started' | 'verified' | 'failed' | 'not_needed'; steps: SyntheticStep[]
}
export type SyntheticPage = {
  schema_version: 1; site_id: 'magrabi-sit'; environment: 'sit'; generated_at: string
  schedule_enabled: boolean; interval_minutes: 60
  state: 'disabled' | 'ready' | 'running' | 'attention_required' | 'stale'
  last_run_at: string | null; next_run_at: string | null
  summary: Record<typeof RUN_STATUSES[number], number>; runs: SyntheticRun[]
  pagination: { limit: number; offset: number; total: number; has_more: boolean }
}
export type SyntheticQuery = { limit: number; offset: number }
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
const duration = (v: unknown): v is number | null => v === null || integer(v, 0, 900_000)
function fail(): never { throw new Error('unsupported_synthetic_response') }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const own = Object.keys(value)
  if (own.length !== keys.length || own.some(k => !keys.includes(k))) return fail()
  return value as Record<string, unknown>
}
function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T)
}
/** Accept canonical UTC with optional microseconds; reject Date.parse's invalid-day rollover. */
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
}
const optionalUtc = (value: unknown): value is string | null => value === null || utc(value)

export function validSyntheticQuery(value: SyntheticQuery): boolean {
  return integer(value.limit, 1, 50) && integer(value.offset, 0, 10_000)
}

function decodeRun(input: unknown, generated: number): SyntheticRun {
  const r = exact(input, ['run_id', 'site_id', 'environment', 'scheduled_at', 'started_at', 'finished_at',
    'updated_at', 'status', 'duration_ms', 'candidate_attempts', 'payment_boundary', 'cleanup_status', 'steps'])
  if (typeof r.run_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.run_id)
    || r.site_id !== 'magrabi-sit' || r.environment !== 'sit' || !utc(r.scheduled_at) || !utc(r.started_at)
    || !utc(r.updated_at) || !optionalUtc(r.finished_at) || !member(r.status, RUN_STATUSES)
    || !duration(r.duration_ms) || !integer(r.candidate_attempts, 0, 5)
    || !member(r.payment_boundary, ['checkout_only', 'gateway_reached'])
    || !member(r.cleanup_status, ['not_started', 'verified', 'failed', 'not_needed'])
    || !Array.isArray(r.steps) || r.steps.length !== SYNTHETIC_STEPS.length) return fail()
  const start = Date.parse(r.started_at), update = Date.parse(r.updated_at)
  if (Date.parse(r.scheduled_at) > start || start > update || update > generated + 5_000 || update - start > 900_000
    || (r.status === 'running' ? r.finished_at !== null || r.duration_ms !== null
      : r.finished_at === null || r.duration_ms === null)
    || r.finished_at !== null && (Date.parse(r.finished_at) < start || Date.parse(r.finished_at) > update
      || Math.abs((r.duration_ms as number) - (Date.parse(r.finished_at) - start)) > 1_000)) return fail()
  const steps = r.steps.map((raw, index): SyntheticStep => {
    const s = exact(raw, ['id', 'status', 'duration_ms', 'http_status', 'reason_code'])
    if (s.id !== SYNTHETIC_STEPS[index] || !member(s.status, STEP_STATUSES) || !duration(s.duration_ms)
      || !(s.http_status === null || integer(s.http_status, 100, 599)) || !member(s.reason_code, REASON_CODES)
      || ['pending', 'running', 'passed'].includes(s.status) && s.reason_code !== 'none'
      || ['failed', 'blocked'].includes(s.status) && s.reason_code === 'none'
      || s.status === 'passed' && s.http_status !== null && (s.http_status as number) >= 400
      || !['pending', 'running'].includes(s.status) && s.duration_ms === null
      || r.status !== 'running' && ['pending', 'running'].includes(s.status)) return fail()
    return { id: SYNTHETIC_STEPS[index], status: s.status, duration_ms: s.duration_ms,
      http_status: s.http_status as number | null, reason_code: s.reason_code }
  })
  const cleanupStates = { not_started: ['pending', 'running'], verified: ['passed'], failed: ['failed'], not_needed: ['skipped'] }
  if (!cleanupStates[r.cleanup_status].includes(steps[7].status) || steps.filter(s => s.status === 'running').length > 1
    || r.cleanup_status === 'failed' && (steps[7].reason_code !== 'cleanup_failed' || !['running', 'failed', 'interrupted'].includes(r.status))
    || r.status === 'passed' && (r.cleanup_status !== 'verified' || steps.some(s => s.status !== 'passed'))
    || r.status === 'failed' && !steps.some(s => s.status === 'failed')
    || r.status === 'blocked' && (!steps.some(s => s.status === 'blocked') || steps.some(s => s.status === 'failed'))) return fail()
  return { run_id: r.run_id, site_id: 'magrabi-sit', environment: 'sit', scheduled_at: r.scheduled_at,
    started_at: r.started_at, finished_at: r.finished_at, updated_at: r.updated_at, status: r.status,
    duration_ms: r.duration_ms, candidate_attempts: r.candidate_attempts, payment_boundary: r.payment_boundary,
    cleanup_status: r.cleanup_status, steps }
}

/** Exact-key decoding prevents newly added private fields silently entering a browser view. */
export function decodeSynthetics(input: unknown, expected?: SyntheticQuery): SyntheticPage {
  const d = exact(input, ['schema_version', 'site_id', 'environment', 'generated_at', 'schedule_enabled',
    'interval_minutes', 'state', 'last_run_at', 'next_run_at', 'summary', 'runs', 'pagination'])
  if (d.schema_version !== 1 || d.site_id !== 'magrabi-sit' || d.environment !== 'sit' || !utc(d.generated_at)
    || typeof d.schedule_enabled !== 'boolean' || d.interval_minutes !== 60
    || !member(d.state, ['disabled', 'ready', 'running', 'attention_required', 'stale'])
    || !optionalUtc(d.last_run_at) || !optionalUtc(d.next_run_at)
    || d.next_run_at !== null && (!d.schedule_enabled || Date.parse(d.next_run_at) < Date.parse(d.generated_at))
    || d.last_run_at !== null && Date.parse(d.last_run_at) > Date.parse(d.generated_at)) return fail()
  const p = exact(d.pagination, ['limit', 'offset', 'total', 'has_more'])
  if (!integer(p.limit, 1, 50) || !integer(p.offset, 0, 10_000) || !integer(p.total, 0, 1_000_000)
    || typeof p.has_more !== 'boolean' || !Array.isArray(d.runs) || d.runs.length > p.limit
    || p.has_more !== (p.offset + d.runs.length < p.total)
    || d.runs.length !== Math.min(p.limit, Math.max(0, p.total - p.offset))
    || expected && (!validSyntheticQuery(expected) || p.limit !== expected.limit || p.offset !== expected.offset)) return fail()
  const counts = exact(d.summary, RUN_STATUSES)
  if (RUN_STATUSES.some(k => !integer(counts[k], 0, 1_000_000)) || (counts.running as number) > 1
    || RUN_STATUSES.reduce((sum, k) => sum + (counts[k] as number), 0) !== p.total) return fail()
  const runs = d.runs.map(raw => decodeRun(raw, Date.parse(d.generated_at as string)))
  if (new Set(runs.map(r => r.run_id)).size !== runs.length) return fail()
  for (const status of RUN_STATUSES) if (runs.filter(r => r.status === status).length > (counts[status] as number)) return fail()
  return { schema_version: 1, site_id: 'magrabi-sit', environment: 'sit', generated_at: d.generated_at,
    schedule_enabled: d.schedule_enabled, interval_minutes: 60, state: d.state,
    last_run_at: d.last_run_at, next_run_at: d.next_run_at,
    summary: Object.fromEntries(RUN_STATUSES.map(k => [k, counts[k]])) as SyntheticPage['summary'], runs,
    pagination: { limit: p.limit, offset: p.offset, total: p.total, has_more: p.has_more } }
}

export function syntheticFresh(page: SyntheticPage | null, now = Date.now()): boolean {
  return !!page && Number.isFinite(now) && Date.parse(page.generated_at) <= now + 30_000
    && now - Date.parse(page.generated_at) <= 45_000
}
export function syntheticDuration(ms: number | null): string {
  if (ms === null) return 'Not measured'
  return ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`
}
export function syntheticTime(value: string | null): string {
  return value === null ? 'Not recorded' : new Date(value).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}
export function syntheticPassRate(summary: SyntheticPage['summary']): string {
  const checked = summary.passed + summary.failed
  return checked ? `${Math.round(summary.passed / checked * 100)}%` : 'Not available'
}
export const REASON_TEXT: Record<SyntheticReason, string> = {
  none: 'No issue recorded.', not_configured: 'The synthetic journey is not configured.',
  auth_failed: 'The dedicated test account could not sign in.', mfa_required: 'An identity challenge needs human attention; it was not bypassed.',
  site_unavailable: 'The runner could not reach the expected site.', selector_changed: 'The expected page control was not found; review the journey selectors.',
  no_stock: 'No eligible in-stock candidate was found. This is blocked test coverage, not proof of an outage.',
  stock_changed: 'Stock changed during the journey. This is blocked test coverage, not proof of an outage.',
  cart_not_empty: 'The test account already had a cart. Existing items were not removed.',
  cart_verification_failed: 'The runner could not verify its own cart change.', shipping_failed: 'The expected shipping step could not be verified.',
  payment_boundary_not_approved: 'This payment boundary is not approved; the journey stopped safely.',
  payment_not_reached: 'The configured payment boundary was not reached.', forbidden_payment_action: 'A disallowed payment or order action was stopped.',
  unexpected_origin: 'Navigation left the reviewed origin allowlist and was stopped.', step_timeout: 'This step exceeded its time limit.',
  run_timeout: 'The bounded journey exceeded its time limit.', cleanup_failed: 'Cleanup was not verified. Pause further runs for manual review.',
  runner_lost: 'The runner stopped reporting; the outcome and cart need manual review.', concurrent_run: 'Another run owns this account; no duplicate journey was started.',
  internal_error: 'The monitoring runner reported an internal error; this alone does not prove a website outage.',
  results_unavailable: 'Monitoring evidence is unavailable; website health is unknown.',
}
