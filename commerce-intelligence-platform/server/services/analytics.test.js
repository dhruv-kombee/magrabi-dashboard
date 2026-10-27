import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeClarityReport, normalizeGa4Report, reportingWindow } from './analytics.js'

test('GA4 normalizer totals only known commerce events and preserves absent events', () => {
  const result = normalizeGa4Report({
    dimensionHeaders: [{ name: 'date' }, { name: 'eventName' }],
    metricHeaders: [{ name: 'eventCount' }],
    rows: [
      { dimensionValues: [{ value: '20261020' }, { value: 'add_to_cart' }], metricValues: [{ value: '4' }] },
      { dimensionValues: [{ value: '20261021' }, { value: 'add_to_cart' }], metricValues: [{ value: '3' }] },
      { dimensionValues: [{ value: '20261021' }, { value: 'purchase' }], metricValues: [{ value: '1' }] },
      { dimensionValues: [{ value: '20261021' }, { value: 'page_view' }], metricValues: [{ value: '100' }] },
    ],
  })

  assert.equal(result.metricsAvailable, true)
  assert.deepEqual(result.events, { add_to_cart: 7, purchase: 1 })
  assert.equal('begin_checkout' in result.events, false)
})

test('GA4 response without matching events does not fabricate zero counts', () => {
  const result = normalizeGa4Report({
    dimensionHeaders: [{ name: 'date' }, { name: 'eventName' }],
    metricHeaders: [{ name: 'eventCount' }],
  })

  assert.equal(result.metricsAvailable, false)
  assert.equal(result.events, null)
  assert.match(result.responseShape, /no matching standard commerce events/)
})

test('Clarity normalizer returns aggregate allowlisted metrics and omits URL data', () => {
  const result = normalizeClarityReport([
    {
      metricName: 'Traffic',
      information: [{
        totalSessionCount: '42',
        totalBotSessionCount: '3',
        distantUserCount: '35',
        PagesPerSessionPercentage: 1.4,
        URL: '/checkout?email=private@example.invalid',
      }],
    },
    {
      metricName: 'Engagement',
      information: [{ RageClickCount: '2', ScriptErrorCount: 1 }],
    },
  ])

  assert.equal(result.metricsAvailable, true)
  assert.deepEqual(result.metrics, {
    Traffic: {
      totalSessionCount: 42,
      totalBotSessionCount: 3,
      distantUserCount: 35,
      PagesPerSessionPercentage: 1.4,
    },
    Engagement: { RageClickCount: 2, ScriptErrorCount: 1 },
  })
  assert.doesNotMatch(JSON.stringify(result), /checkout|email|private/)
})

test('Clarity grouped rows are not incorrectly summed into aggregate values', () => {
  const result = normalizeClarityReport([
    {
      metricName: 'Traffic',
      information: [{ totalSessionCount: '5' }, { totalSessionCount: '7' }],
    },
  ])

  assert.equal(result.metricsAvailable, false)
  assert.equal(result.metrics, null)
})

test('GA4 reporting dates use each property timezone and full calendar days', () => {
  const timestamp = Date.parse('2026-10-27T21:00:00.000Z')
  assert.deepEqual(
    reportingWindow({ start: timestamp, end: timestamp }, 'Asia/Dubai'),
    { start: '2026-10-28', end: '2026-10-28' },
  )
})
