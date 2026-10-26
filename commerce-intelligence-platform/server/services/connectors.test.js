import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAlertRule } from './alerts.js'
import { queryProvider } from './gateways.js'
import { fetchJson, publicConnectorResult, redactError } from './http.js'
import { hasGrafanaMetricContract } from './infra.js'
import { classifyAzureAuthFailure } from './traffic.js'
import { buildUnifiedOrders } from '../router.js'

test('missing metrics remain null and are never converted to zero', () => {
  const result = publicConnectorResult({ status: 'METRICS_UNAVAILABLE', configured: true, source: 'control', value: null })
  assert.equal(result.metricsAvailable, false)
  assert.equal(result.value, null)
})

test('gateway inquiry uses GET and exposes authentication failure without response data', async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.CHECKOUT_SECRET_KEY
  process.env.CHECKOUT_SECRET_KEY = 'unit-test-placeholder'
  let method
  globalThis.fetch = async (_url, options) => {
    method = options?.method
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await queryProvider('checkout', { configured: true, requiredKeys: ['CHECKOUT_SECRET_KEY'], apiUrl: 'https://example.invalid', reportPath: '/reports', name: 'Checkout.com' })
    assert.equal(method, 'GET')
    assert.equal(result.status, 'AUTHENTICATION_FAILED')
    assert.equal(result.live, false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.CHECKOUT_SECRET_KEY
    else process.env.CHECKOUT_SECRET_KEY = previousKey
  }
})

test('malformed successful gateway response is not reported as verified metrics', async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.TABBY_SECRET_KEY
  process.env.TABBY_SECRET_KEY = 'unit-test-placeholder'
  globalThis.fetch = async () => new Response('{bad json', { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const result = await queryProvider('tabby', { configured: true, requiredKeys: ['TABBY_SECRET_KEY'], apiUrl: 'https://example.invalid', reportPath: '/payments', name: 'Tabby' })
    assert.equal(result.status, 'ERROR')
    assert.equal(result.metricsAvailable, false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.TABBY_SECRET_KEY
    else process.env.TABBY_SECRET_KEY = previousKey
  }
})

test('connector timeout is classified and does not look successful', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
  try {
    await assert.rejects(() => fetchJson('https://example.invalid', {}, 5), (error) => error.name === 'AbortError')
  } finally { globalThis.fetch = previousFetch }
})

test('alert evaluation refuses to treat absent telemetry as zero and never dispatches', async () => {
  const result = await evaluateAlertRule({ rule: 'orders', threshold: 10, notifyTeams: true, notifyEmail: true }, {})
  assert.equal(result.metricAvailable, false)
  assert.equal(result.triggered, false)
  assert.equal(result.channels.teams, 'DISABLED')
  assert.equal(result.channels.email, 'DISABLED')
})

test('Saleor counts are not substituted for unavailable Macula counts', () => {
  const result = buildUnifiedOrders({ status: 'OK', live: true, orders: 42 }, { status: 'NOT_CONFIGURED', live: false }, '2026-10-26T00:00:00.000Z')
  assert.equal(result.orders, 42)
  assert.equal(result.oms.orders, null)
  assert.equal(result.oms.previousOrders, null)
  assert.equal(result.reconciliation.status, 'METRICS_UNAVAILABLE')
  assert.equal(result.gatewayCounts, null)
})

test('Macula gateway attribution stays explicitly sampled', () => {
  const result = buildUnifiedOrders({ status: 'OK', live: true, orders: 42 }, { status: 'OK', live: true, orders: 40, previousOrders: 35, todaySoFar: 4, gatewayCounts: { Tabby: 3 }, methodCounts: { Tabby: 3 }, sampleSize: 40, sampleLimit: 100 })
  assert.deepEqual(result.gatewaySample, { status: 'SAMPLED', size: 40, limit: 100 })
  assert.equal(result.gatewayCounts, null)
})

test('Azure MFA is distinct from invalid service-principal authentication', () => {
  assert.equal(classifyAzureAuthFailure({ error: 'invalid_grant', error_description: 'AADSTS50079 MFA required' }, 'UserAccount', 400), 'MFA_UNSUPPORTED')
  assert.equal(classifyAzureAuthFailure({ error: 'invalid_client' }, 'ServicePrincipal', 401), 'AUTHENTICATION_FAILED')
})

test('Grafana health alone is not a metric query contract', () => {
  assert.equal(hasGrafanaMetricContract('', ''), false)
  assert.equal(hasGrafanaMetricContract('prometheus-uid', ''), false)
  assert.equal(hasGrafanaMetricContract('prometheus-uid', 'histogram_quantile(...)'), true)
})

test('error redaction removes authorization and query secrets', () => {
  const message = redactError(new Error('Bearer abc.def? client https://x.test/?token=super-secret'))
  assert.doesNotMatch(message, /abc\.def|super-secret/)
})
