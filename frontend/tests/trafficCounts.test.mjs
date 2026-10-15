// Synthetic aggregate fixtures only; never imports app.py or reads live telemetry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInput, classLabel, countLabel, dateInput, decodeCatalog, decodeReport, decodeTicket,
  inputToIso, matchesRange, presetRange, rangeLabel, safeSourceUrl, sourceErrorMessage, sourceReadLabel, summaryCounts } from '../src/trafficCounts/model.ts'
import { createTrafficCountsClient, csvPath, pollDelay, TrafficCountsError, trafficErrorMessage } from '../src/trafficCounts/request.ts'

const source = { id: 'ecom_ingress', label: 'ECom ingress', layer: 'Origin ingress', url: 'https://ecom-grafana.test-magrabi.com',
  notes: ['Sources overlap.'], granularity: 'exact_status' }
const row = { scope: 'all', total: 120, counts: { '200': 90, '204': 5, '301': 10, '499': 4, '500': 6, '502': 3, '0': 1 }, unclassified: 1 }
const report = () => ({ id: 'abc123', status: 'complete', range: { start: '2026-10-12T18:30:00Z', end: '2026-10-13T18:30:00Z', timezone: 'Asia/Kolkata' },
  generatedAt: '2026-10-14T04:00:00Z', progress: { completed: 24, total: 24 }, sources: [{ ...source, status: 'complete',
    coverage: { expected: 24, observed: 24 }, totals: [row], daily: [{ date: '2026-10-13', status: 'complete', coverage: { expected: 24, observed: 24 }, rows: [row] }] }] })
const input = () => ({ ...report().range, sources: ['ecom_ingress'] })
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('exact response classes partition the total without adding sources', () => {
  const n = summaryCounts(row, 'exact_status')
  assert.deepEqual(n, { total: 120, http200: 90, other2xx: 5, group2xx: 95, group3xx: 10, group4xx: 4, group5xx: 9, other: 2 })
  assert.equal(n.http200 + n.other2xx + n.group3xx + n.group4xx + n.group5xx + n.other, row.total)
})
test('group-only gateway never passes2xx off as HTTP200 or other2xx', () => {
  const n = summaryCounts({ scope: 'all', total: 18, counts: { '1xx': 0, '2xx': 12, '3xx': 2, '4xx': 1, '5xx': 2 }, unclassified: 1 }, 'status_group')
  assert.equal(n.http200, null); assert.equal(n.other2xx, null); assert.equal(n.group2xx, 12); assert.equal(n.other, 1)
})
test('unavailable rows remain unknown even when counts are empty', () => {
  const n = summaryCounts({ scope: 'all', total: null, counts: {}, unclassified: null }, 'exact_status')
  assert.ok(Object.values(n).every(value => value === null)); assert.equal(countLabel(null), '—'); assert.equal(countLabel(0), '0')
})
test('null code/category stays unknown while an absent exact status is0 in an observed row', () => {
  assert.equal(summaryCounts({ ...row, counts: { ...row.counts, '200': null } }, 'exact_status').http200, null)
  assert.equal(summaryCounts({ ...row, counts: { '500': 2 } }, 'exact_status').http200, 0)
  assert.equal(summaryCounts({ ...row, counts: { '5xx': null } }, 'status_group').group5xx, null)
})
test('catalog accepts finite source list and rejects invented sources, duplicates or excess bounds', () => {
  const catalog = { sources: [{ ...source, configured: true }], maxDays: 7, retentionDays: 93, timezones: ['Asia/Kolkata', 'UTC'], filterVersion: '2026-10-14-v1' }
  assert.equal(decodeCatalog(catalog).sources[0].configured, true)
  assert.throws(() => decodeCatalog({ ...catalog, maxDays: 8 }))
  assert.throws(() => decodeCatalog({ ...catalog, sources: [{ ...source, id: 'arbitrary', configured: true }] }))
  assert.throws(() => decodeCatalog({ ...catalog, sources: [catalog.sources[0], catalog.sources[0]] }))
})
test('report retains per-day coverage and partial status', () => {
  const r = report(); r.status = 'partial'; r.sources[0].status = 'partial'
  r.sources[0].daily[0].status = 'partial'; r.sources[0].daily[0].coverage.observed = 20
  const decoded = decodeReport(r, 'abc123')
  assert.equal(decoded.sources[0].daily[0].status, 'partial'); assert.equal(decoded.sources[0].daily[0].coverage.observed, 20)
})
test('response validation rejects negative/unsafe counts, prototype labels, identity mismatch and excess coverage', () => {
  for (const n of [-1, Number.MAX_SAFE_INTEGER + 1, '100', 1.25]) {
    const r = report(); r.sources[0].totals = [{ ...row, total: n }]; assert.throws(() => decodeReport(r))
  }
  const r = report(); r.sources[0].totals = [{ ...row, counts: JSON.parse('{"__proto__":12}') }]
  assert.throws(() => decodeReport(r)); assert.throws(() => decodeReport(report(), 'wrong'))
  const c = report(); c.sources[0].coverage.observed = 25; assert.throws(() => decodeReport(c))
  assert.throws(() => decodeTicket({ id: '../escape', status: 'running', cached: false }))
})
test('IST conversion is independent of the workstation timezone', () => {
  assert.equal(inputToIso('2026-10-13T00:00', 'Asia/Kolkata'), '2026-10-12T18:30:00.000Z')
  assert.equal(dateInput(Date.parse('2026-10-12T18:30:00Z'), 'Asia/Kolkata'), '2026-10-13T00:00')
  assert.equal(inputToIso('2026-10-13T00:00', 'UTC'), '2026-10-13T00:00:00.000Z')
  assert.throws(() => inputToIso('2026-02-30T10:00', 'UTC'))
})
test('last5completed days uses local midnight rather than a rolling120hour window', () => {
  const now = Date.parse('2026-10-14T04:23:45Z')
  assert.deepEqual(presetRange('5days', 'Asia/Kolkata', now), { start: '2026-10-09T00:00', end: '2026-10-14T00:00' })
  assert.deepEqual(presetRange('1h', 'Asia/Kolkata', now), { start: '2026-10-14T08:53', end: '2026-10-14T09:53' })
  assert.deepEqual(presetRange('24h', 'UTC', now), { start: '2026-10-13T04:23', end: '2026-10-14T04:23' })
})
test('date validation rejects reversed, future, too old, overlong and unselected ranges', () => {
  const now = Date.parse('2026-10-14T04:23:45Z'), ids = ['ecom_ingress']
  const build = (a, b, selected = ids) => buildInput(a, b, 'UTC', selected, 7, 93, now)
  assert.throws(() => build('2026-10-14T01:00', '2026-10-13T01:00'))
  assert.throws(() => build('2026-10-14T01:00', '2026-10-14T05:00'))
  assert.throws(() => build('2026-10-01T01:00', '2026-10-14T01:00'))
  assert.throws(() => build('2026-01-01T01:00', '2026-01-02T01:00'))
  assert.throws(() => build('2026-10-13T01:00', '2026-10-14T01:00', []))
  assert.throws(() => build('2026-10-13T01:00', '2026-10-14T01:00', ['../bad']))
  assert.equal(build('2026-10-13T01:00', '2026-10-14T01:00').end, '2026-10-14T01:00:00.000Z')
})
test('snapshot comparison includes sources and timezone, not only date labels', () => {
  const decoded = decodeReport(report())
  assert.equal(matchesRange(decoded, input()), true)
  assert.equal(matchesRange(decoded, { ...input(), sources: ['frontdoor_main'] }), false)
  assert.equal(matchesRange(decoded, { ...input(), timezone: 'UTC' }), false)
  assert.match(rangeLabel(decoded.range), /IST \(UTC\+05:30\)/)
  assert.equal(classLabel('browser_like'), 'Browser like')
})
test('operational links and CSV export reject arbitrary hosts and path injection', () => {
  assert.ok(safeSourceUrl('https://portal.azure.com/#resource/abc'))
  assert.ok(safeSourceUrl('https://ecom-grafana.test-magrabi.com/explore'))
  for (const url of ['javascript:alert(1)', 'https://example.com', 'https://portal.azure.com.evil.test', 'https://user:pass@portal.azure.com', 'http://portal.azure.com', 'https://portal.azure.com:444']) assert.equal(safeSourceUrl(url), null)
  assert.equal(csvPath('../secret'), null); assert.equal(csvPath('abc123'), '/api/insights/traffic/reports/abc123/export.csv')
})
test('POST creates aggregate report with anti-CSRF header, same-origin session and exact dates', async () => {
  const calls = [], c = createTrafficCountsClient(async (path, init) => { calls.push({ path, init }); return response({ id: 'abc123', status: 'running', cached: false }, 202) })
  const result = await c.create(input(), new AbortController().signal)
  assert.equal(result.status, 'running'); assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/insights/traffic/reports'); assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers['X-Traffic-Request'], '1'); assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), input())
})
test('poll rejects a report for a different requested time range', async () => {
  const c = createTrafficCountsClient(async () => response(report()))
  await assert.rejects(c.report('abc123', new AbortController().signal, { ...input(), end: '2026-10-13T17:30:00Z' }), e => e.code === 'invalid_response')
})
test('error bodies and credentials are never echoed and requests do not retry', async () => {
  let calls = 0
  const c = createTrafficCountsClient(async () => { calls++; return new Response('raw credential from provider', { status: 500 }) })
  await assert.rejects(c.create(input(), new AbortController().signal), e => !trafficErrorMessage(e).includes('credential'))
  assert.equal(calls, 1)
  const forbidden = createTrafficCountsClient(async () => new Response('', { status: 403 }))
  await assert.rejects(forbidden.create(input(), new AbortController().signal), e => e.code === 'forbidden')
})
test('pre-aborted operations never start a request or polling delay', async () => {
  const controller = new AbortController(); controller.abort()
  const c = createTrafficCountsClient(async () => { throw new Error('must not run') })
  await assert.rejects(c.sources(controller.signal), e => e.code === 'cancelled')
  await assert.rejects(pollDelay(controller.signal), e => e.code === 'cancelled')
})
test('poll wait cancels promptly and never resumes after abort', async () => {
  const controller = new AbortController(), pending = pollDelay(controller.signal, 1000)
  controller.abort(); await assert.rejects(pending, e => e instanceof TrafficCountsError && e.code === 'cancelled')
})
test('streaming response is capped even without Content-Length', async () => {
  let cancelled = false
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1_000_001)) }, cancel() { cancelled = true } })
  const c = createTrafficCountsClient(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(c.sources(new AbortController().signal), e => e.code === 'invalid_response')
  assert.equal(cancelled, true)
})
test('source reads and cached chunk provenance survive decoding independently of report generation', () => {
  const r = report()
  Object.assign(r.sources[0], { cachedChunks: 4, fetchedAt: '2026-10-14T03:50:00Z',
    oldestFetchedAt: '2026-10-14T03:00:00Z', newestFetchedAt: '2026-10-14T03:55:00Z', error: 'log_data_missing' })
  const s = decodeReport(r).sources[0]
  assert.equal(s.cachedChunks, 4); assert.equal(s.oldestFetchedAt, '2026-10-14T03:00:00Z')
  assert.equal(s.newestFetchedAt, '2026-10-14T03:55:00Z'); assert.equal(s.fetchedAt, '2026-10-14T03:50:00Z')
  const label = sourceReadLabel(s)
  assert.match(label, /Last source read 14\/10\/2026, 03:55:00 UTC/)
  assert.match(label, /oldest contributing read 14\/10\/2026, 03:00:00 UTC/)
  assert.match(label, /4 chunks reused from cache/); assert.match(label, /1h.*5m/)
  assert.equal(s.error, 'log_data_missing'); assert.match(sourceErrorMessage(s.error), /not proof of zero traffic/)
})
test('source provenance remains optional but rejects invalid timestamps and unsafe error text length', () => {
  assert.equal(sourceReadLabel(decodeReport(report()).sources[0]), null)
  assert.match(sourceReadLabel({ fetchedAt: '2026-10-14T03:50:00Z', cachedChunks: 0 }), /0 chunks/)
  const r = report(); Object.assign(r.sources[0], { oldestFetchedAt: '2026-10-14T04:00:00Z', newestFetchedAt: '2026-10-14T03:00:00Z' })
  assert.throws(() => decodeReport(r))
  for (const value of [{ fetchedAt: 'not-a-date' }, { cachedChunks: -1 }, { error: 'x'.repeat(81) }]) {
    const fixture = report(); Object.assign(fixture.sources[0], value); assert.throws(() => decodeReport(fixture))
  }
})
test('only known source diagnostic codes become messages; unknown text is never echoed', () => {
  assert.match(sourceErrorMessage('authentication_failed'), /Authentication/)
  assert.match(sourceErrorMessage('auth'), /Authentication/)
  assert.match(sourceErrorMessage('access_denied'), /does not have access/)
  assert.match(sourceErrorMessage('source_not_configured'), /not been connected/)
  assert.equal(sourceErrorMessage('untrusted raw provider text'), 'Unable to query this source.')
  assert.equal(sourceErrorMessage('__proto__'), 'Unable to query this source.')
  assert.equal(sourceErrorMessage(undefined), null)
})
