// Offline fixtures only. No browser journey, portal server, credentials or external network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as model from '../src/monitoring/syntheticModel.ts'
import * as client from '../src/monitoring/syntheticClient.ts'

const query = { limit: 20, offset: 0 }
const now = '2026-09-21T10:01:00.000000Z'
function run(status = 'passed') {
  return { run_id: '11111111-2222-4333-8444-555555555555', site_id: 'magrabi-sit', environment: 'sit',
    scheduled_at: '2026-09-21T10:00:00Z', started_at: '2026-09-21T10:00:01Z',
    finished_at: status === 'running' ? null : '2026-09-21T10:00:20Z', updated_at: '2026-09-21T10:00:20Z',
    status, duration_ms: status === 'running' ? null : 19_000, candidate_attempts: 1,
    payment_boundary: 'checkout_only', cleanup_status: status === 'running' ? 'not_started' : 'verified',
    steps: model.SYNTHETIC_STEPS.map(id => ({ id, status: status === 'running' ? 'pending' : id === 'site' && status === 'failed' ? 'failed'
      : id === 'product' && status === 'blocked' ? 'blocked' : 'passed', duration_ms: status === 'running' ? null : 1_000,
      http_status: null, reason_code: id === 'site' && status === 'failed' ? 'site_unavailable' : id === 'product' && status === 'blocked' ? 'no_stock' : 'none' })) }
}
function page(status = 'passed') {
  return { schema_version: 1, site_id: 'magrabi-sit', environment: 'sit', generated_at: now,
    schedule_enabled: true, interval_minutes: 60, state: status === 'running' ? 'running' : 'ready',
    last_run_at: '2026-09-21T10:00:01Z', next_run_at: '2026-09-21T11:00:00Z',
    summary: { passed: 0, failed: 0, blocked: 0, interrupted: 0, running: 0, [status]: 1 },
    runs: [run(status)], pagination: { limit: 20, offset: 0, total: 1, has_more: false } }
}
function disabled() {
  return { ...page(), schedule_enabled: false, state: 'disabled', last_run_at: null, next_run_at: null,
    summary: { passed: 0, failed: 0, blocked: 0, interrupted: 0, running: 0 },
    runs: [], pagination: { limit: 20, offset: 0, total: 0, has_more: false } }
}
const rejects = body => assert.throws(() => model.decodeSynthetics(body, query), /^Error: unsupported_synthetic_response$/)

test('exact disabled payload is honest empty evidence, not a successful run', () => {
  assert.deepEqual(model.decodeSynthetics(disabled(), query), disabled())
  assert.equal(model.syntheticPassRate(disabled().summary), 'Not available')
})
test('successful eight-step journey requires verified cleanup', () => {
  assert.deepEqual(model.decodeSynthetics(page(), query), page())
  for (const cleanup of ['not_started', 'failed', 'not_needed']) {
    const p = page(); p.runs[0].cleanup_status = cleanup; rejects(p)
  }
  const p = page(); p.runs[0].steps[7].status = 'skipped'; rejects(p)
})
test('all run states decode without representing blocked as outage', () => {
  for (const status of model.RUN_STATUSES) assert.equal(model.decodeSynthetics(page(status)).runs[0].status, status)
  const p = page('blocked'); p.runs[0].steps[2] = { id: 'product', status: 'blocked', duration_ms: 200, http_status: null, reason_code: 'no_stock' }
  assert.equal(model.decodeSynthetics(p).runs[0].steps[2].reason_code, 'no_stock')
  assert.match(model.REASON_TEXT.no_stock, /not proof of an outage/)
})
test('reject unknown or private keys at every DTO level', () => {
  for (const pick of [p => p, p => p.summary, p => p.pagination, p => p.runs[0], p => p.runs[0].steps[0]]) {
    const p = page(); pick(p).raw_cookie = 'offline-canary-must-not-escape'; rejects(p)
  }
})
test('reject missing fields at every DTO level', () => {
  for (const [pick, key] of [[p => p, 'state'], [p => p.summary, 'passed'], [p => p.pagination, 'total'],
    [p => p.runs[0], 'cleanup_status'], [p => p.runs[0].steps[0], 'reason_code']]) {
    const p = page(); delete pick(p)[key]; rejects(p)
  }
})
test('reject wrong environment, site, version and arbitrary reason codes', () => {
  for (const [key, value] of [['site_id', 'unknown'], ['environment', 'prod'], ['schema_version', 2]]) rejects({ ...page(), [key]: value })
  for (const key of ['site_id', 'environment']) { const p = page(); p.runs[0][key] = 'prod'; rejects(p) }
  const p = page(); p.runs[0].steps[0].reason_code = 'private-exception-text'; rejects(p)
})
test('steps are exactly eight in fixed order with validated statuses', () => {
  const fewer = page(); fewer.runs[0].steps.pop(); rejects(fewer)
  const more = page(); more.runs[0].steps.push(more.runs[0].steps[0]); rejects(more)
  const order = page(); order.runs[0].steps.reverse(); rejects(order)
  const state = page(); state.runs[0].steps[0].status = 'healthy'; rejects(state)
  const duplicate = page(); duplicate.runs[0].steps[1].id = 'site'; rejects(duplicate)
})
test('UTC timestamps reject offsets, invalid days and reversed order', () => {
  for (const bad of ['2026-02-30T10:00:00Z', '2026-09-21T10:00:00+00:00', '2026-09-21', '2026-09-21T25:00:00Z']) rejects({ ...page(), generated_at: bad })
  for (const [key, bad] of [['scheduled_at', '2026-09-21T10:01:00Z'], ['started_at', '2026-09-21T10:00:21Z'],
    ['finished_at', '2026-09-21T09:59:00Z'], ['updated_at', '2026-09-21T10:02:00Z']]) {
    const p = page(); p.runs[0][key] = bad; rejects(p)
  }
})
test('bounded duration, attempts and HTTP status reject impossible numbers', () => {
  for (const value of [-1, 900_001, 0.5, Infinity, NaN, '2']) {
    const p = page(); p.runs[0].duration_ms = value; rejects(p)
    const s = page(); s.runs[0].steps[0].duration_ms = value; rejects(s)
  }
  for (const value of [-1, 6, 0.2, '1']) { const p = page(); p.runs[0].candidate_attempts = value; rejects(p) }
  for (const value of [99, 600, '200', 200.5]) { const p = page(); p.runs[0].steps[0].http_status = value; rejects(p) }
})
test('running and terminal time fields cannot contradict their status', () => {
  const active = page('running'); active.runs[0].finished_at = now; rejects(active)
  const elapsed = page('running'); elapsed.runs[0].duration_ms = 2; rejects(elapsed)
  const terminal = page(); terminal.runs[0].finished_at = null; rejects(terminal)
  const duration = page(); duration.runs[0].duration_ms = null; rejects(duration)
})
test('semantic guards reject contradictory step reasons, HTTP failures and cleanup', () => {
  const badReason = page(); badReason.runs[0].steps[0].reason_code = 'site_unavailable'; rejects(badReason)
  const badHttp = page(); badHttp.runs[0].steps[0].http_status = 500; rejects(badHttp)
  const noFailure = page('failed'); noFailure.runs[0].steps[0].status = 'passed'; noFailure.runs[0].steps[0].reason_code = 'none'; rejects(noFailure)
  const noBlock = page('blocked'); noBlock.runs[0].steps[2].status = 'passed'; noBlock.runs[0].steps[2].reason_code = 'none'; rejects(noBlock)
  const noDuration = page(); noDuration.runs[0].steps[0].duration_ms = null; rejects(noDuration)
  const wrongElapsed = page(); wrongElapsed.runs[0].duration_ms = 1; rejects(wrongElapsed)
  const active = page('running'); active.runs[0].steps[0].status = 'running'; active.runs[0].steps[1].status = 'running'; rejects(active)
})
test('run identifiers are lower-case UUIDs and unique', () => {
  for (const id of ['not-an-id', 'AAAAAAAA-2222-4333-8444-555555555555', '1'.repeat(1000)]) { const p = page(); p.runs[0].run_id = id; rejects(p) }
  const p = page(); p.runs.push(structuredClone(p.runs[0])); p.pagination.total = 2; p.summary.passed = 2; rejects(p)
})
test('pagination matches request and exact retained counts', () => {
  const p = page(); p.pagination.has_more = true; rejects(p)
  const count = page(); count.summary.passed = 2; rejects(count)
  const off = page(); off.pagination.offset = 20; rejects(off)
  for (const limit of [0, 51, 1.5]) rejects({ ...page(), pagination: { ...page().pagination, limit } })
  assert.equal(model.validSyntheticQuery({ limit: 50, offset: 10_000 }), true)
  assert.equal(model.validSyntheticQuery({ limit: 50, offset: 10_001 }), false)
  assert.equal(model.validSyntheticQuery({ limit: 1, offset: -1 }), false)
})
test('disabled schedule cannot claim a next run; unknown schedule remains null', () => {
  rejects({ ...page(), schedule_enabled: false })
  rejects({ ...page(), next_run_at: '2026-09-21T09:00:00Z' })
  assert.equal(model.decodeSynthetics({ ...page(), next_run_at: null }).next_run_at, null)
})
test('freshness expires independently of an old passed run and rejects far-future snapshot', () => {
  const p = model.decodeSynthetics(page()), time = Date.parse(now)
  assert.equal(model.syntheticFresh(p, time + 45_000), true)
  assert.equal(model.syntheticFresh(p, time + 45_001), false)
  assert.equal(model.syntheticFresh(p, time - 30_001), false)
  assert.equal(model.syntheticFresh(null, time), false)
})
test('pass rate excludes blocked/interrupted/running with explicit denominator', () => {
  assert.equal(model.syntheticPassRate({ passed: 3, failed: 1, blocked: 100, interrupted: 100, running: 1 }), '75%')
  assert.equal(model.syntheticDuration(null), 'Not measured')
  assert.equal(model.syntheticDuration(0), '0 ms')
  assert.equal(model.syntheticDuration(1500), '1.5 s')
  assert.equal(model.syntheticDuration(900_000), '15.0 min')
  assert.equal(model.syntheticTime(null), 'Not recorded')
  assert.equal(model.syntheticTime('2026-09-21T10:00:01Z'), '2026-09-21 10:00:01 UTC')
})
test('client uses fixed same-origin GET and cookies, never bearer token or user URL', async () => {
  let request
  const load = client.createSyntheticClient(async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify(page()), { headers: { 'content-type': 'application/json' } })
  })
  const result = await client.loadSyntheticPage(load, query, new AbortController())
  assert.equal(result.runs.length, 1)
  assert.equal(request.url, '/api/monitoring/v1/sit/synthetics?limit=20&offset=0')
  assert.equal(request.options.method, 'GET'); assert.equal(request.options.credentials, 'same-origin')
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.cache, 'no-store')
  assert.deepEqual(request.options.headers, { Accept: 'application/json' })
})
test('client refuses out-of-bounds input before transport', async () => {
  let calls = 0
  const load = client.createSyntheticClient(async () => { calls++; throw new Error('must not run') })
  await assert.rejects(load({ limit: 20, offset: -1 }, new AbortController().signal), /unavailable/)
  assert.equal(calls, 0)
})
test('unauthorized and server errors are fixed safe codes, never response text', async () => {
  for (const status of [401, 403, 500]) {
    const load = client.createSyntheticClient(async () => new Response('private-offline-canary', { status }))
    await assert.rejects(client.loadSyntheticPage(load, query, new AbortController()), e =>
      e instanceof client.SyntheticRequestError && e.code === (status === 500 ? 'unavailable' : 'unauthorized') && !e.message.includes('canary'))
  }
})
test('client bounds response bytes before parsing and rejects non-JSON or invalid UTF8', async () => {
  for (const response of [new Response('x'.repeat(262_145), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response(Uint8Array.from([255]), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '262145' } })]) {
    const load = client.createSyntheticClient(async () => response)
    await assert.rejects(client.loadSyntheticPage(load, query, new AbortController()), /unavailable/)
  }
})
test('private or malformed JSON never leaks through loader errors', async () => {
  const p = page(); p.runs[0].customer_email = 'offline@example.invalid'
  await assert.rejects(client.loadSyntheticPage(async () => p, query, new AbortController()), /^Error: unavailable$/)
  await assert.rejects(client.loadSyntheticPage(async () => { throw new Error('private-offline-canary') }, query, new AbortController()), /^Error: unavailable$/)
})
test('pre-aborted requests never invoke injected loader', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0
  await assert.rejects(client.loadSyntheticPage(async () => { calls++; return page() }, query, controller), /cancelled/)
  assert.equal(calls, 0)
})
test('deadline settles even if loader ignores abort', async () => {
  const controller = new AbortController()
  await assert.rejects(client.loadSyntheticPage(() => new Promise(() => {}), query, controller, 5), e => e.code === 'timed_out')
  assert.equal(controller.signal.aborted, true)
})
test('external cancellation discards late response', async () => {
  const controller = new AbortController()
  let resolve
  const pending = client.loadSyntheticPage(() => new Promise(done => { resolve = done }), query, controller)
  await Promise.resolve(); controller.abort()
  await assert.rejects(pending, e => e.code === 'cancelled')
  resolve(page())
})
test('read-only component renders without any data request or fabricated run on import/SSR', () => {
  const require = createRequire(import.meta.url)
  const source = readFileSync(new URL('../src/monitoring/SyntheticMonitoring.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 } }).outputText
  const mod = { exports: {} }
  const dependency = name => name === './syntheticModel' ? model : name === './syntheticClient' ? client
    : name.endsWith('.module.css') ? { default: new Proxy({}, { get: (_, key) => String(key) }) } : require(name)
  new Function('require', 'module', 'exports', compiled)(dependency, mod, mod.exports)
  let calls = 0
  const html = renderToStaticMarkup(React.createElement(mod.exports.SyntheticMonitoring, { loadRuns: async () => { calls++; return page() } }))
  assert.equal(calls, 0)
  assert.match(html, /Synthetic Monitoring/); assert.match(html, /Health unknown/)
  assert.match(html, /Payment boundary, not payment completion/)
  assert.doesNotMatch(html, /Run now|11111111-2222|Bearer|<form/)
})
