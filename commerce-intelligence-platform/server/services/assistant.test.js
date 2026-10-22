import test from 'node:test'
import assert from 'node:assert/strict'
import { answerCommerceQuestion, classifyQuestion, deterministicAnswer, interpretQuestionWithModel, modelAnswer, parseAnswerNeeds, resolveScope } from './assistant.js'

const now = Date.parse('2026-10-22T10:00:00Z')

test('query scope respects explicit country and rolling period within allowed values', () => {
  const scope = resolveScope({ brand: 'all', country: 'AE', timezone: 'Dubai', start: now - 86_400_000, end: now }, 'Show Saudi revenue for the last 7 days', now)
  assert.equal(scope.country, 'SA')
  assert.equal(scope.brand, 'all')
  assert.equal(scope.start, now - 7 * 86_400_000)
  assert.equal(scope.end, now)
})

test('country scope survives a Saudi spelling mistake and explicit scope wins over model hints', () => {
  assert.equal(resolveScope({ country: 'all' }, 'what is the sell of today in soudi arebia', now).country, 'SA')
  assert.equal(resolveScope({ country: 'all' }, 'Saudi sales today', now, { country: 'AE', period: 'yesterday' }).country, 'SA')
  assert.equal(resolveScope({ country: 'all' }, 'Saudi sales today', now, { country: 'AE', period: 'yesterday' }).start, Date.parse('2026-10-21T20:00:00Z'))
  assert.equal(resolveScope({ country: 'all' }, 'sales for sudi', now, { country: 'SA' }).country, 'SA')
  assert.equal(resolveScope({ brand: 'Magrabi', country: 'AE' }, 'sales today', now, { brand: 'all', country: 'all' }).brand, 'Magrabi')
  assert.equal(resolveScope({ brand: 'Magrabi', country: 'AE' }, 'sales today', now, { brand: 'all', country: 'all' }).country, 'AE')
})

test('today versus yesterday selects today with the comparison window available', () => {
  const scope = resolveScope({}, 'Compare today with yesterday', now)
  assert.equal(scope.start, Date.parse('2026-10-21T20:00:00Z'))
  assert.equal(scope.end, now)
})

test('natural sales wording resolves to a today sales question', () => {
  assert.equal(classifyQuestion('what is the todays sell'), 'sales')
  assert.equal(classifyQuestion("How are today's sales?"), 'sales')
  assert.equal(classifyQuestion('How much did we sell today?'), 'revenue')
  assert.equal(classifyQuestion('How are we doing today?'), 'sales')
  assert.equal(classifyQuestion('What did we make today?'), 'revenue')
  assert.equal(classifyQuestion('How is it going?'), 'clarify')
  const scope = resolveScope({}, 'what is the todays sell', now)
  assert.equal(scope.start, Date.parse('2026-10-21T20:00:00Z'))
  assert.equal(scope.end, now)
})

test('two-part last-month question receives a direct count, comparison, and plain-language definitions', () => {
  const question = 'can you provide me the exact number of the order between last month? Can you explain me what is the meaning of saleor order and prior window orders'
  const hints = parseAnswerNeeds(question)
  assert.equal(classifyQuestion(question), 'orders')
  assert.equal(hints.compare, true)
  assert.equal(hints.saleorDefinition, true)
  assert.equal(hints.priorDefinition, true)
  assert.equal(hints.includeCountryBreakdown, false)
  const scope = resolveScope({ timezone: 'Dubai' }, question, now)
  assert.equal(scope.start, now - 30 * 86_400_000)
  const answer = deterministicAnswer({
    intent: 'orders', scope, responseHints: hints,
    orders: { live: true, orders: 1735, previousOrders: 1987, changePct: -12.7, period: '30 days' },
  })
  assert.match(answer, /^Saleor recorded 1,735 placed orders in the last 30 days/)
  assert.match(answer, /prior comparable window had 1,987 orders/)
  assert.match(answer, /252 fewer \(-12\.7%\)/)
  assert.match(answer, /A Saleor order is created through the storefront/)
  assert.match(answer, /“Prior-window orders” counts the immediately preceding period/)
  assert.match(answer, /rolling 30-day window, not the previous calendar month/)
  assert.doesNotMatch(answer, /Country counts:/)
})

test('question parsing can use validated Gemini facets without inventing definitions', () => {
  const hints = parseAnswerNeeds('Show orders', { compare: true, explain: ['prior_window_orders', 'unknown'] })
  assert.equal(hints.compare, true)
  assert.equal(hints.priorDefinition, true)
  assert.equal(hints.saleorDefinition, false)
})

test('a sales answer puts Macula receipts first and separates Saleor placed value', () => {
  const answer = deterministicAnswer({
    intent: 'sales', orders: { live: true, period: 'today', orders: 9, revenueByCurrency: { AED: 2555.38, SAR: 4723 } },
    oms: { live: true, orders: 7 },
  })
  assert.match(answer, /Macula OMS received 7 orders/)
  assert.match(answer, /Saleor separately recorded 9 placed orders/)
  assert.match(answer, /AED 2,555\.38/)
  assert.match(answer, /SAR 4,723/)
  assert.match(answer, /not verified OMS-received revenue/)
})

test('explicit Macula order request never substitutes Saleor', () => {
  assert.equal(classifyQuestion('Macula OMS orders received today'), 'oms_orders')
  assert.match(deterministicAnswer({ intent: 'oms_orders', oms: { live: true, orders: 7 }, orders: { live: true, orders: 8 } }), /Macula OMS received 7 orders/)
  const missing = deterministicAnswer({ intent: 'oms_orders', oms: { live: false }, orders: { live: true, orders: 8 } })
  assert.match(missing, /cannot verify Macula OMS/)
  assert.doesNotMatch(missing, /8 orders/)
})

test('reconciliation explains stages without inventing a sync cause', () => {
  assert.equal(classifyQuestion('Why do Saleor and Macula orders differ?'), 'reconciliation')
  const answer = deterministicAnswer({ intent: 'reconciliation', orders: { live: true, orders: 8, period: 'today' }, oms: { live: true, orders: 7 } })
  assert.match(answer, /Saleor placed 8 orders and Macula OMS received 7/)
  assert.match(answer, /count difference is 1/)
  assert.match(answer, /cannot be determined without matching order IDs/)
  const unavailable = deterministicAnswer({ intent: 'reconciliation', orders: { live: true, orders: 8 }, oms: { live: false } })
  assert.match(unavailable, /cannot verify a current/)
  assert.doesNotMatch(unavailable, /count difference is/)
})

test('ambiguous either-or question asks back before fetching data', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unexpected external request') }
  try {
    const result = await answerCommerceQuestion({ query: 'Sales or traffic today?' })
    assert.equal(result.intent, 'clarify')
    assert.equal(result.evidence.length, 0)
    assert.equal(result.clarification.length, 3)
    assert.match(result.answer, /need one detail/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scope rejects invalid and overlong date ranges', () => {
  assert.throws(() => resolveScope({ start: now, end: now - 1 }, '', now), RangeError)
  assert.throws(() => resolveScope({ start: now - 91 * 86_400_000, end: now }, '', now), RangeError)
})

test('follow-up intent preserves the prior topic', () => {
  assert.equal(classifyQuestion('What about Saudi Arabia?', [{ role: 'user', content: 'Show revenue by currency' }]), 'revenue')
  const prior = resolveScope({ country: 'all' }, 'Saudi sales today', now)
  assert.equal(resolveScope(prior, 'What about UAE?', now).country, 'AE')
})

test('missing traffic metrics never become a fabricated number', () => {
  const answer = deterministicAnswer({ intent: 'traffic', traffic: { live: true, metricStatus: 'Connection confirmed; verified metrics not mapped.' } })
  assert.match(answer, /verified metrics not mapped/)
  assert.doesNotMatch(answer, /\b\d+(?:\.\d+)?\s*(?:%|requests)\b/)
})

test('OMS count difference is not called a confirmed sync exception', () => {
  const answer = deterministicAnswer({
    intent: 'orders', scope: { country: 'AE' },
    orders: { live: true, period: 'today', orders: 12, previousOrders: 10, changePct: 20, comparison: 'previous day' },
    oms: { live: true, orders: 11 },
  })
  assert.match(answer, /count difference is 1/)
  assert.match(answer, /not a confirmed per-order sync exception/)
})

test('unmapped OMS channel is not presented as a comparable zero', () => {
  const answer = deterministicAnswer({
    intent: 'orders', scope: { country: 'KW' },
    orders: { live: true, period: 'today', orders: 4, previousOrders: 3, changePct: 33.3 },
    oms: { live: true, noChannel: true, orders: 0 },
  })
  assert.match(answer, /no mapped channel group/)
  assert.doesNotMatch(answer, /count difference/)
})

test('outside questions are refused before any platform or model request', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unexpected external request') }
  try {
    const result = await answerCommerceQuestion({ query: 'Tell me the football score and order count' })
    assert.equal(result.mode, 'platform')
    assert.deepEqual(result.evidence, [])
    assert.match(result.answer, /outside those sources/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a dashboard-only journey question is not mistaken for an outside topic', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unexpected external request') }
  try {
    const result = await answerCommerceQuestion({ query: 'What is customer journey conversion?' })
    assert.equal(result.intent, 'unavailable')
    assert.deepEqual(result.evidence, [])
    assert.match(result.answer, /no.*verified live data feed/i)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Gemini request uses server-side key, selected model, and no external tools', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.GEMINI_API_KEY
  const originalModel = process.env.GEMINI_MODEL
  process.env.GEMINI_API_KEY = 'test-only-key'
  process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite'
  let inspected = false
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /models\/gemini-3\.1-flash-lite:generateContent$/)
    assert.equal(options.headers['x-goog-api-key'], 'test-only-key')
    const body = JSON.parse(options.body)
    assert.equal(body.tools, undefined)
    assert.equal(body.contents.at(-1).role, 'user')
    assert.match(body.systemInstruction.parts[0].text, /only questions about this Magrabi commerce platform/)
    inspected = true
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'There were 12 orders.' }] } }] }) }
  }
  try {
    const text = await modelAnswer('How many orders?', [], {
      intent: 'orders', scope: { brand: 'all', country: 'all', tz: 'Dubai', start: 1, end: 2 },
      orders: { live: true, period: 'today', orders: 12, previousOrders: 10, changePct: 20, countryBreakdown: {} },
      oms: { live: false },
    })
    assert.equal(text, 'There were 12 orders.')
    assert.equal(inspected, true)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
    if (originalModel === undefined) delete process.env.GEMINI_MODEL
    else process.env.GEMINI_MODEL = originalModel
  }
})

test('Gemini interprets ambiguous platform wording without seeing connector data', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'test-only-key'
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    assert.match(body.contents[0].parts[0].text, /Current question: How are we doing\?/)
    assert.doesNotMatch(body.contents[0].parts[0].text, /Verified platform snapshot/)
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: 'sales', country: 'SA', brand: null, period: 'today', days: null }) }] } }] }) }
  }
  try {
    const result = await interpretQuestionWithModel('How are we doing?')
    assert.equal(result.intent, 'sales')
    assert.equal(result.country, 'SA')
    assert.equal(result.period, 'today')
    assert.equal(result.status, 'ready')
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  }
})

test('temporary Gemini failure is retried before using the platform fallback', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'test-only-key'
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return calls === 1
      ? { ok: false, status: 503 }
      : { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Saleor recorded 9 orders.' }] } }] }) }
  }
  try {
    const diagnostics = {}
    const answer = await modelAnswer('How many orders?', [], {
      intent: 'orders', scope: { brand: 'all', country: 'all', tz: 'Dubai', start: 1, end: 2 },
      orders: { live: true, period: 'today', orders: 9, previousOrders: 8, countryBreakdown: {} },
    }, diagnostics)
    assert.equal(answer, 'Saleor recorded 9 orders.')
    assert.equal(diagnostics.status, 'ready')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  }
})

test('Gemini answer with a number absent from displayed evidence is discarded', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'test-only-key'
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'There were 9 orders and a 22.2% drop.' }] } }] }) })
  try {
    const diagnostics = {}
    const answer = await modelAnswer('How were sales?', [], {
      intent: 'sales', scope: { brand: 'all', country: 'SA', tz: 'Dubai', start: 1, end: 2 },
      generatedAt: '2026-10-22T10:00:00Z',
      orders: { live: true, status: 'OK', period: 'today', orders: 9, revenueByCurrency: { SAR: 4723 } },
    }, diagnostics)
    assert.equal(answer, null)
    assert.equal(diagnostics.status, 'ungrounded_output')
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  }
})
