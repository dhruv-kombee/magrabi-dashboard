import { createHash } from 'node:crypto'
import { GoogleAuth } from 'google-auth-library'
import { config } from '../config.js'
import { fetchJson, publicConnectorResult } from './http.js'

const GA4_EVENTS = [
  'view_item',
  'add_to_cart',
  'view_cart',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'purchase',
]
const CLARITY_METRICS = new Set([
  'totalSessionCount',
  'totalBotSessionCount',
  'distantUserCount',
  'distinctUserCount',
  'PagesPerSessionPercentage',
  'EngagementTime',
  'ScrollDepth',
  'DeadClickCount',
  'ExcessiveScroll',
  'RageClickCount',
  'QuickbackClick',
  'ScriptErrorCount',
  'ErrorClickCount',
])
const analyticsCache = new Map()

function parseJsonArray(value, fields) {
  if (!value) return { entries: [], configured: false, error: false }
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 2) {
      return { entries: [], configured: false, error: true }
    }
    const entries = parsed.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const entry = {}
      for (const field of fields) {
        if (typeof item[field] !== 'string' || !item[field].trim()) return null
        entry[field] = item[field].trim()
      }
      if (typeof item.label !== 'string' || !item.label.trim()) return null
      entry.label = item.label.trim().slice(0, 80)
      if (typeof item.brand === 'string') entry.brand = item.brand.trim()
      return entry
    })
    if (entries.some((entry) => !entry)) return { entries: [], configured: false, error: true }
    return { entries, configured: true, error: false }
  } catch {
    return { entries: [], configured: false, error: true }
  }
}

function getSourceConfiguration() {
  const properties = parseJsonArray(config.analytics.ga4Properties, ['id', 'timezone'])
  const projects = parseJsonArray(config.analytics.clarityProjects, ['token'])
  let credentials = null
  let credentialError = false
  if (config.analytics.ga4ServiceAccountJson) {
    try {
      const parsed = JSON.parse(config.analytics.ga4ServiceAccountJson)
      if (parsed?.type !== 'service_account' || !parsed.client_email || !parsed.private_key) throw new Error()
      credentials = parsed
    } catch {
      credentialError = true
    }
  }

  const validProperties = properties.entries.every((property) => {
    if (!/^\d+$/.test(property.id)) return false
    try {
      new Intl.DateTimeFormat('en', { timeZone: property.timezone })
      return true
    } catch {
      return false
    }
  })
  const validProjects = projects.entries.every((project) => Boolean(project.token))
  return {
    ga4: {
      configured: Boolean(credentials && properties.configured && validProperties && !properties.error && !credentialError),
      invalid: properties.error || credentialError || (properties.configured && !validProperties),
      credentials,
      properties: validProperties ? properties.entries : [],
    },
    clarity: {
      configured: Boolean(projects.configured && validProjects && !projects.error),
      invalid: projects.error || (projects.configured && !validProjects),
      projects: validProjects ? projects.entries : [],
    },
  }
}

export function getAnalyticsConfigurationStatus() {
  const sources = getSourceConfiguration()
  return {
    ga4: {
      configured: sources.ga4.configured,
      status: sources.ga4.invalid ? 'INVALID_CONFIGURATION' : sources.ga4.configured ? 'CONFIGURED_BUT_NOT_VERIFIED' : 'NOT_CONFIGURED',
      propertyLabels: sources.ga4.properties.map(({ label }) => label),
    },
    clarity: {
      configured: sources.clarity.configured,
      status: sources.clarity.invalid ? 'INVALID_CONFIGURATION' : sources.clarity.configured ? 'CONFIGURED_BUT_NOT_VERIFIED' : 'NOT_CONFIGURED',
      projectLabels: sources.clarity.projects.map(({ label }) => label),
    },
  }
}

function dateValue(value, fallback, timezone) {
  const parsed = Number(value)
  const date = new Date(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback)
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]))
  return `${values.year}-${values.month}-${values.day}`
}

export function reportingWindow(options = {}, timezone = 'UTC') {
  const endMs = Number(options.end)
  const startMs = Number(options.start)
  const now = Date.now()
  const end = dateValue(endMs, now, timezone)
  const start = dateValue(startMs, now - 7 * 86_400_000, timezone)
  if (start > end) throw new Error('The analytics start date must be on or before the end date.')
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
  if (days > 365) throw new Error('GA4 reports are limited to a 366-day date window.')
  return { start, end }
}

function cacheGet(key) {
  const cached = analyticsCache.get(key)
  if (!cached || Date.now() >= cached.expiresAt) {
    analyticsCache.delete(key)
    return null
  }
  return cached.value
}

function cacheSet(key, value, ttlMs) {
  for (const [cachedKey, cached] of analyticsCache) {
    if (Date.now() >= cached.expiresAt) analyticsCache.delete(cachedKey)
  }
  if (analyticsCache.size >= 128 && !analyticsCache.has(key)) {
    analyticsCache.delete(analyticsCache.keys().next().value)
  }
  analyticsCache.set(key, { value, expiresAt: Date.now() + ttlMs })
  return value
}

function safeConnectorFailure(error, source, label, emptyData) {
  const timedOut = error?.name === 'AbortError'
  return publicConnectorResult({
    status: timedOut ? 'TIMEOUT' : 'ERROR',
    configured: true,
    source,
    label,
    error: timedOut ? 'The source did not respond before the timeout.' : 'The read-only analytics request failed. Verify the server-side access configuration and source permissions.',
    ...emptyData,
  })
}

export function normalizeGa4Report(payload) {
  if (!Array.isArray(payload?.dimensionHeaders) || !Array.isArray(payload?.metricHeaders)) {
    return { metricsAvailable: false, events: null, responseShape: 'missing GA4 report headers or rows' }
  }
  const dateIndex = payload.dimensionHeaders.findIndex((header) => header.name === 'date')
  const eventIndex = payload.dimensionHeaders.findIndex((header) => header.name === 'eventName')
  const countIndex = payload.metricHeaders.findIndex((header) => header.name === 'eventCount')
  if (dateIndex < 0 || eventIndex < 0 || countIndex < 0) {
    return { metricsAvailable: false, events: null, responseShape: 'required date, eventName, or eventCount field missing' }
  }

  const totals = new Map()
  for (const row of Array.isArray(payload.rows) ? payload.rows : []) {
    const date = row.dimensionValues?.[dateIndex]?.value
    const name = row.dimensionValues?.[eventIndex]?.value
    const rawCount = row.metricValues?.[countIndex]?.value
    const count = Number(rawCount)
    if (!/^\d{8}$/.test(date || '') || !GA4_EVENTS.includes(name) || typeof rawCount !== 'string' || !/^\d+(?:\.\d+)?$/.test(rawCount) || !Number.isFinite(count)) continue
    totals.set(name, (totals.get(name) || 0) + count)
  }
  if (totals.size === 0) return { metricsAvailable: false, events: null, responseShape: 'no matching standard commerce events returned' }
  return {
    metricsAvailable: true,
    events: Object.fromEntries(GA4_EVENTS.filter((name) => totals.has(name)).map((name) => [name, totals.get(name)])),
  }
}

export function normalizeClarityReport(payload) {
  if (!Array.isArray(payload)) return { metricsAvailable: false, metrics: null, responseShape: 'expected an array of Clarity metrics' }
  const metrics = {}
  for (const item of payload) {
    if (typeof item?.metricName !== 'string' || !Array.isArray(item.information)) continue
    if (item.information.length !== 1) continue
    const aggregate = {}
    const row = item.information[0]
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    for (const [key, rawValue] of Object.entries(row)) {
      if (!CLARITY_METRICS.has(key)) continue
      const value = Number(rawValue)
      const numericString = typeof rawValue === 'string' && /^-?(?:\d+\.?\d*|\.\d+)$/.test(rawValue)
      if ((typeof rawValue === 'number' || numericString) && Number.isFinite(value)) aggregate[key] = value
    }
    if (Object.keys(aggregate).length) metrics[item.metricName] = aggregate
  }
  if (Object.keys(metrics).length === 0) {
    return { metricsAvailable: false, metrics: null, responseShape: 'no supported aggregate fields returned' }
  }
  return { metricsAvailable: true, metrics }
}

async function fetchGa4Property(property, credentials, options) {
  const window = reportingWindow(options, property.timezone)
  const cacheKey = `ga4:${property.id}:${window.start}:${window.end}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  try {
    const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] })
    const client = await auth.getClient()
    const tokenResult = await client.getAccessToken()
    const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token
    if (!token) return publicConnectorResult({ status: 'AUTHENTICATION_FAILED', configured: true, source: 'Google Analytics 4', label: property.label, events: null })
    const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${property.id}:runReport`
    const { response, payload } = await fetchJson(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: window.start, endDate: window.end }],
        dimensions: [{ name: 'date' }, { name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            inListFilter: { values: GA4_EVENTS, caseSensitive: true },
          },
        },
        limit: 10000,
      }),
    }, config.requestTimeoutMs)
    if (response.status === 401 || response.status === 403) {
      return publicConnectorResult({ status: 'AUTHENTICATION_FAILED', configured: true, source: 'Google Analytics 4', label: property.label, httpStatus: response.status, events: null })
    }
    if (!response.ok) {
      return publicConnectorResult({ status: 'ERROR', configured: true, source: 'Google Analytics 4', label: property.label, httpStatus: response.status, error: `GA4 Data API returned HTTP ${response.status}.`, events: null })
    }
    const normalized = normalizeGa4Report(payload)
    const result = publicConnectorResult({
      status: normalized.metricsAvailable ? 'LIVE_VERIFIED' : 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING',
      configured: true,
      live: true,
      metricsAvailable: normalized.metricsAvailable,
      source: 'Google Analytics 4 Data API',
      label: property.label,
      reportingWindow: window,
      reportingTimezone: property.timezone,
      checkedAt: new Date().toISOString(),
      ...normalized,
    })
    return cacheSet(cacheKey, result, config.analytics.ga4CacheTtlMs)
  } catch (error) {
    return safeConnectorFailure(error, 'Google Analytics 4', property.label, { events: null })
  }
}

async function fetchClarityProject(project) {
  const tokenFingerprint = createHash('sha256').update(project.token).digest('hex')
  const cacheKey = `clarity:${project.label}:${tokenFingerprint}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const empty = { metrics: null, reportingWindow: 'Previous 3 days (UTC)' }
  try {
    const url = new URL('https://www.clarity.ms/export-data/api/v1/project-live-insights')
    url.searchParams.set('numOfDays', '3')
    const { response, payload } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${project.token}`, Accept: 'application/json' },
    }, config.requestTimeoutMs)
    if (response.status === 401 || response.status === 403) {
      return publicConnectorResult({ status: 'AUTHENTICATION_FAILED', configured: true, source: 'Microsoft Clarity Data Export API', label: project.label, httpStatus: response.status, ...empty })
    }
    if (response.status === 429) {
      return publicConnectorResult({ status: 'RATE_LIMITED', configured: true, source: 'Microsoft Clarity Data Export API', label: project.label, httpStatus: response.status, message: 'Clarity has reached its daily project request limit.', ...empty })
    }
    if (!response.ok) {
      return publicConnectorResult({ status: 'ERROR', configured: true, source: 'Microsoft Clarity Data Export API', label: project.label, httpStatus: response.status, error: `Clarity Data Export API returned HTTP ${response.status}.`, ...empty })
    }
    const normalized = normalizeClarityReport(payload)
    const result = publicConnectorResult({
      status: normalized.metricsAvailable ? 'LIVE_VERIFIED' : 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING',
      configured: true,
      live: true,
      metricsAvailable: normalized.metricsAvailable,
      source: 'Microsoft Clarity Data Export API',
      label: project.label,
      reportingWindow: empty.reportingWindow,
      checkedAt: new Date().toISOString(),
      ...normalized,
    })
    return cacheSet(cacheKey, result, config.analytics.clarityCacheTtlMs)
  } catch (error) {
    return safeConnectorFailure(error, 'Microsoft Clarity Data Export API', project.label, empty)
  }
}

export async function fetchAnalyticsSummary(options = {}) {
  const sources = getSourceConfiguration()
  let window
  try {
    window = reportingWindow(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid analytics reporting window.'
    return {
      status: 'ERROR',
      error: message,
      checkedAt: new Date().toISOString(),
      ga4: [],
      clarity: [],
    }
  }

  const ga4 = sources.ga4.configured
    ? await Promise.all(sources.ga4.properties.map((property) => fetchGa4Property(property, sources.ga4.credentials, options)))
    : [publicConnectorResult({
      status: sources.ga4.invalid ? 'INVALID_CONFIGURATION' : 'NOT_CONFIGURED',
      configured: false,
      source: 'Google Analytics 4 Data API',
      missing: ['GA4_SERVICE_ACCOUNT_JSON', 'GA4_PROPERTIES'],
      events: null,
    })]
  const clarity = sources.clarity.configured
    ? await Promise.all(sources.clarity.projects.map(fetchClarityProject))
    : [publicConnectorResult({
      status: sources.clarity.invalid ? 'INVALID_CONFIGURATION' : 'NOT_CONFIGURED',
      configured: false,
      source: 'Microsoft Clarity Data Export API',
      missing: ['CLARITY_PROJECTS'],
      metrics: null,
      reportingWindow: 'Previous 3 days (UTC)',
    })]

  return {
    status: 'COMPLETE',
    checkedAt: new Date().toISOString(),
    ga4: await Promise.all(ga4),
    clarity: await Promise.all(clarity),
  }
}
