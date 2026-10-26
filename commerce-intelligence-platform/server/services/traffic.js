import { config, hasEnv } from '../config.js'
import { connectorError, fetchJson, publicConnectorResult } from './http.js'

export function getTrafficConfiguration() {
  const servicePrincipal = hasEnv('AZURE_CLIENT_ID') && hasEnv('AZURE_CLIENT_SECRET') && hasEnv('AZURE_TENANT_ID')
  const userAccount = hasEnv('AZURE_USERNAME') && hasEnv('AZURE_PASSWORD')
  return { configured: servicePrincipal || userAccount, servicePrincipal, userAccount }
}

export function isTrafficConfigured() { return getTrafficConfiguration().configured }

let cachedAzureToken = null
let azureTokenExpiry = 0

export function classifyAzureAuthFailure(payload, authType, httpStatus) {
  const description = String(payload?.error_description || '')
  const mfa = /AADSTS(?:50076|50079)|multi-factor|mfa/i.test(description) || (authType === 'UserAccount' && payload?.error === 'invalid_grant')
  return mfa ? 'MFA_UNSUPPORTED' : httpStatus === 401 || httpStatus === 403 ? 'AUTHENTICATION_FAILED' : 'ERROR'
}

async function requestToken(body, authType) {
  try {
    const tenant = config.azure.tenantId
    const { response, payload } = await fetchJson(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
    }, config.requestTimeoutMs)
    if (!response.ok || typeof payload?.access_token !== 'string') {
      return { status: classifyAzureAuthFailure(payload, authType, response.status), authType, httpStatus: response.status }
    }
    cachedAzureToken = payload.access_token
    azureTokenExpiry = Date.now() + Math.max(60, Number(payload.expires_in) - 120) * 1000
    return { status: 'LIVE_VERIFIED', authType, token: cachedAzureToken }
  } catch (error) {
    return { ...connectorError(error), authType }
  }
}

export async function getAzureMonitorToken() {
  if (cachedAzureToken && Date.now() < azureTokenExpiry) return { status: 'LIVE_VERIFIED', authType: 'Cached', token: cachedAzureToken }
  const available = getTrafficConfiguration()
  if (available.servicePrincipal) {
    return requestToken({ grant_type: 'client_credentials', client_id: config.azure.clientId, client_secret: config.azure.clientSecret, scope: 'https://management.azure.com/.default' }, 'ServicePrincipal')
  }
  if (available.userAccount) {
    return requestToken({ grant_type: 'password', client_id: '04b07795-8ddb-461a-bbee-02f9e1bf7b46', username: config.azure.username, password: config.azure.password, scope: 'https://management.azure.com/.default openid offline_access' }, 'UserAccount')
  }
  return { status: 'NOT_CONFIGURED', authType: 'None' }
}

function metricPoints(payload) {
  if (!Array.isArray(payload?.value)) return null
  const points = []
  for (const metric of payload.value) {
    const name = metric?.name?.value || metric?.name?.localizedValue
    for (const series of metric?.timeseries || []) {
      for (const point of series?.data || []) {
        const value = point.total ?? point.average ?? point.maximum ?? point.minimum
        if (name && point.timeStamp && Number.isFinite(Number(value))) points.push({ metric: name, timestamp: point.timeStamp, value: Number(value) })
      }
    }
  }
  return points
}

export async function fetchTrafficTelemetry(options = {}) {
  const configuration = getTrafficConfiguration()
  const empty = { trafficTrends: [], httpCodes: null }
  if (!configuration.configured) return publicConnectorResult({ status: 'NOT_CONFIGURED', configured: false, source: 'Azure Monitor', missing: ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'], auth: { servicePrincipal: 'NOT_CONFIGURED', userAccount: 'NOT_CONFIGURED' }, ...empty })
  const auth = await getAzureMonitorToken()
  if (!auth.token) return publicConnectorResult({ status: auth.status, configured: true, source: 'Azure Monitor', auth: { type: auth.authType, status: auth.status }, httpStatus: auth.httpStatus, ...empty })
  try {
    const end = new Date(Number(options.end) || Date.now())
    const start = new Date(Number(options.start) || end.getTime() - 3_600_000)
    const resourceId = `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.Cdn/profiles/${config.azure.profileName}`
    const url = new URL(`https://management.azure.com${resourceId}/providers/microsoft.insights/metrics`)
    url.searchParams.set('api-version', '2018-01-01')
    url.searchParams.set('metricnames', config.azure.metricNames)
    url.searchParams.set('timespan', `${start.toISOString()}/${end.toISOString()}`)
    url.searchParams.set('interval', 'PT5M')
    url.searchParams.set('aggregation', 'Total,Average')
    const { response, payload } = await fetchJson(url, { headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' } }, config.requestTimeoutMs)
    if (response.status === 401 || response.status === 403) return publicConnectorResult({ status: 'AUTHENTICATION_FAILED', configured: true, source: 'Azure Monitor metrics', httpStatus: response.status, auth: { type: auth.authType, status: 'LIVE_VERIFIED' }, ...empty })
    if (!response.ok) return publicConnectorResult({ status: 'ERROR', configured: true, source: 'Azure Monitor metrics', httpStatus: response.status, error: `Azure Monitor metrics returned HTTP ${response.status}.`, auth: { type: auth.authType, status: 'LIVE_VERIFIED' }, ...empty })
    const points = metricPoints(payload)
    if (!points || points.length === 0) return publicConnectorResult({ status: 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING', configured: true, live: true, source: 'Azure Monitor metrics', auth: { type: auth.authType, status: 'LIVE_VERIFIED' }, responseShape: Array.isArray(payload?.value) ? 'value[] without numeric datapoints' : 'missing value[]', ...empty })
    const grouped = new Map()
    for (const point of points) {
      const row = grouped.get(point.timestamp) || { timestamp: point.timestamp }
      if (/requestcount/i.test(point.metric)) row.totalRequests = point.value
      if (/latency/i.test(point.metric)) row.clientLatency = point.value
      grouped.set(point.timestamp, row)
    }
    const trafficTrends = [...grouped.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).map((row) => ({
      ...row,
      rps: Number.isFinite(row.totalRequests) ? Math.round((row.totalRequests / 300) * 100) / 100 : null,
    }))
    return publicConnectorResult({
      status: 'LIVE_VERIFIED', configured: true, live: true, metricsAvailable: true, source: 'Azure Front Door / Azure Monitor',
      auth: { type: auth.authType, status: 'LIVE_VERIFIED' }, trafficTrends, httpCodes: null,
      message: 'Only metrics returned by Azure Monitor are exposed. HTTP status buckets remain unavailable unless configured metrics provide them.',
    })
  } catch (error) {
    return publicConnectorResult({ ...connectorError(error), configured: true, source: 'Azure Monitor metrics', auth: { type: auth.authType, status: 'LIVE_VERIFIED' }, ...empty })
  }
}
