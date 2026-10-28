import { fetchSaleorSummary } from './services/saleor.js'
import { fetchMaculaSummary } from './services/macula.js'
import { fetchGatewayTelemetry, getGatewaysConfigurationStatus } from './services/gateways.js'
import { fetchTrafficTelemetry, getTrafficConfiguration } from './services/traffic.js'
import { fetchInfraTelemetry, isInfraConfigured } from './services/infra.js'
import { fetchAnalyticsSummary, getAnalyticsConfigurationStatus } from './services/analytics.js'
import { evaluateAlertRule, isAlertChannelConfigured } from './services/alerts.js'
import { answerCommerceQuestion } from './services/assistant.js'
import { redactError } from './services/http.js'
import { config, hasEnv } from './config.js'
import {
  deleteManagedViewer,
  DEFAULT_VIEWER_PERMISSIONS,
  readManagedUsers,
  readManagedUsersAsync,
  recordAuditLog,
  saveManagedViewer,
  updateManagedViewerPermissions,
  validateManagedUsername,
  validateViewerPermissions,
  VIEWER_PERMISSIONS,
} from './userStore.js'
import {
  authConfigurationStatus,
  authenticateUser,
  clearSessionCookie,
  createSessionToken,
  getRequestSession,
  getSessionTimeoutSeconds,
  loginRateLimit,
  refreshSession,
  setSessionCookie,
  hashPassword,
} from './auth.js'

const queryCache = new Map()
const CACHE_TTL_MS = 60 * 1000
const MANAGED_USER_STORAGE_ERROR = 'Viewer account storage is unavailable. On Render, attach a persistent disk mounted at /var/data; set AUTH_MANAGED_USERS_FILE to /var/data/dashboard-users.json if using a different path.'
const GET_ROUTES = new Set(['/api/commerce/auth/session', '/api/commerce/auth/users', '/api/commerce/health', '/api/commerce/orders/summary', '/api/commerce/gateways/telemetry', '/api/commerce/traffic/edge', '/api/commerce/infra/apm', '/api/commerce/analytics/summary'])
const POST_ROUTES = new Set(['/api/commerce/auth/login', '/api/commerce/auth/logout', '/api/commerce/auth/activity', '/api/commerce/auth/users', '/api/commerce/assistant/query', '/api/commerce/alerts/evaluate'])
const ADMIN_ONLY_ROUTES = new Set(['/api/commerce/auth/users'])
const ROUTE_PERMISSIONS = new Map([
  ['/api/commerce/orders/summary', ['overview', 'orders']],
  ['/api/commerce/gateways/telemetry', ['orders']],
  ['/api/commerce/traffic/edge', ['traffic']],
  ['/api/commerce/infra/apm', ['infra']],
  ['/api/commerce/analytics/summary', ['journey']],
  ['/api/commerce/health', ['sources']],
  ['/api/commerce/alerts/evaluate', ['alerts']],
])

export function canAccessPath(role, pathname, permissions = DEFAULT_VIEWER_PERMISSIONS) {
  if (role === 'admin') return true
  if (ADMIN_ONLY_ROUTES.has(pathname)) return false
  if (pathname === '/api/commerce/assistant/query') return VIEWER_PERMISSIONS.every((permission) => permissions.includes(permission))
  const requiredPermissions = ROUTE_PERMISSIONS.get(pathname)
  return !requiredPermissions || requiredPermissions.some((permission) => permissions.includes(permission))
}

function readJsonBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= maxBytes) body += chunk
    })
    req.on('end', () => {
      if (size > maxBytes) return reject(new Error('Request body is too large.'))
      try { resolve(JSON.parse(body || '{}')) } catch { reject(new Error('Request body must be valid JSON.')) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, payload, statusCode = 200) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=UTF-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function applyCors(req, res) {
  const origin = req.headers?.origin
  if (!origin) return true
  const host = req.headers?.host
  let sameOrigin = false
  try { sameOrigin = new URL(origin).host === host } catch { sameOrigin = false }
  if (!sameOrigin && !config.corsOrigins.includes(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  return true
}

const configuredStatus = (configured) => configured ? 'CONFIGURED_BUT_NOT_VERIFIED' : 'NOT_CONFIGURED'

function healthPayload() {
  const gateways = getGatewaysConfigurationStatus()
  const traffic = getTrafficConfiguration()
  const analytics = getAnalyticsConfigurationStatus()
  const alerts = isAlertChannelConfigured()
  const connector = (name, configured, requiredKeys, extra = {}) => ({ name, configured, status: configuredStatus(configured), requiredKeys, ...extra })
  return {
    status: 'COMPLETE', timestamp: new Date().toISOString(),
    message: 'Configuration inventory only. Use each connector endpoint for live verification.',
    connectors: {
      saleor: connector('Saleor Core GraphQL', hasEnv('SALEOR_USERNAME') && hasEnv('SALEOR_PASSWORD'), ['SALEOR_USERNAME', 'SALEOR_PASSWORD']),
      macula: connector('Macula OMS Order Search', hasEnv('MACULA_TOKEN') || (hasEnv('MACULA_USERNAME') && hasEnv('MACULA_PASSWORD')), ['MACULA_TOKEN or MACULA_USERNAME + MACULA_PASSWORD']),
      ...Object.fromEntries(Object.entries(gateways).map(([key, value]) => [key, connector(value.name, value.configured, value.requiredKeys, { codeStatus: value.reportPath ? 'COMPLETE' : 'CODE_INCOMPLETE' })])),
      azureFrontDoor: connector('Azure Front Door / Monitor', traffic.configured, ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'], { authPaths: { servicePrincipal: traffic.servicePrincipal, userAccount: traffic.userAccount } }),
      grafana: connector('Observability & APM (Grafana)', isInfraConfigured(), ['ECOM_GRAFANA_TOKEN', 'PROMETHEUS_DATASOURCE_UID', 'GRAFANA_LATENCY_QUERY']),
      ga4: connector('Google Analytics 4 Data API', analytics.ga4.configured, ['GA4_SERVICE_ACCOUNT_JSON', 'GA4_PROPERTIES'], { status: analytics.ga4.status, propertyLabels: analytics.ga4.propertyLabels }),
      clarity: connector('Microsoft Clarity Data Export API', analytics.clarity.configured, ['CLARITY_PROJECTS'], { status: analytics.clarity.status, projectLabels: analytics.clarity.projectLabels }),
      alerts: connector('Incident Alerts (Teams / Email)', alerts.teams || alerts.email, ['TEAMS_WEBHOOK_URL or SMTP_*'], { deliveryEnabled: config.alerts.deliveryEnabled, status: config.alerts.deliveryEnabled ? 'CONFIGURED_BUT_NOT_VERIFIED' : 'COMPLETE' }),
      assistant: connector('Commerce Assist (Gemini)', hasEnv('GEMINI_API_KEY') || hasEnv('GOOGLE_API_KEY'), ['GEMINI_API_KEY'], { fallback: 'Built-in grounded platform answer engine' }),
      customerJourney: { name: 'Customer journey events', configured: false, status: 'METRICS_UNAVAILABLE', codeStatus: 'CODE_INCOMPLETE', requiredKeys: [], message: 'Requires consented browser and server-confirmed event instrumentation.' },
    },
  }
}

export function buildUnifiedOrders(saleorResult, maculaResult, checkedAt = new Date().toISOString(), scope = {}) {
  const omsLive = maculaResult.status === 'OK' && maculaResult.live === true
  const omsOrders = omsLive ? maculaResult.orders : null
  const omsPrior = omsLive ? maculaResult.previousOrders : null
  const omsChangePct = Number.isFinite(omsOrders) && Number.isFinite(omsPrior) && omsPrior > 0 ? Math.round(((omsOrders - omsPrior) / omsPrior) * 1000) / 10 : null
  const sampledMethods = omsLive ? maculaResult.methodCounts || null : null
  const sampledOnline = sampledMethods ? (sampledMethods['Card / Apple Pay'] || 0) + (sampledMethods.Tabby || 0) + (sampledMethods.Tamara || 0) : 0
  const sampledCash = sampledMethods?.Cash || 0
  const sampledTotal = sampledOnline + sampledCash
  const saleorIds = Array.isArray(saleorResult.reconciliationOrderIds) ? new Set(saleorResult.reconciliationOrderIds.map(String)) : null
  const priorSaleorIds = Array.isArray(saleorResult.priorReconciliationOrderIds) ? new Set(saleorResult.priorReconciliationOrderIds.map(String)) : null
  const maculaIds = Array.isArray(maculaResult.reconciliationOrderIds) ? new Set(maculaResult.reconciliationOrderIds.map(String)) : null
  const priorMaculaIds = Array.isArray(maculaResult.priorReconciliationOrderIds) ? new Set(maculaResult.priorReconciliationOrderIds.map(String)) : null
  const matchedOrders = saleorIds && maculaIds ? [...saleorIds].filter((id) => maculaIds.has(id)).length : null
  const priorMatchedOrders = priorSaleorIds && priorMaculaIds ? [...priorSaleorIds].filter((id) => priorMaculaIds.has(id)).length : null
  const startMs = Number(scope.start)
  const endMs = Number(scope.end)
  const windowDays = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.max(1, Math.ceil((endMs - startMs) / 86_400_000))
    : null
  const windowComparisonLabel = windowDays === 1 ? 'previous day'
    : windowDays === 7 ? 'previous week'
      : windowDays === 14 ? 'previous 2 weeks'
        : windowDays === 30 ? 'previous month'
          : windowDays ? `previous ${windowDays} days` : 'previous comparable window'
  return {
    status: omsLive ? 'OK' : maculaResult.status,
    configured: maculaResult.configured,
    live: omsLive,
    metricsAvailable: omsLive,
    source: 'Macula OMS read-only search API',
    brand: scope.brand || 'all',
    country: scope.country || 'all',
    period: windowDays ? `${windowDays} ${windowDays === 1 ? 'day' : 'days'}` : 'selected window',
    windowDays,
    windowComparisonLabel,
    date: Number.isFinite(endMs) ? new Date(endMs).toISOString().slice(0, 10) : null,
    orders: omsOrders,
    previousOrders: omsPrior,
    changePct: omsChangePct,
    todaySoFar: omsLive ? maculaResult.todaySoFar : null,
    dailyPoints: omsLive ? maculaResult.dailyPoints || [] : [],
    countryDailyPoints: omsLive ? maculaResult.countryDailyPoints || {} : {},
    countryBreakdown: omsLive ? maculaResult.countryBreakdown || {} : {},
    priorCountryBreakdown: omsLive ? maculaResult.priorCountryBreakdown || {} : {},
    paymentBreakdown: sampledTotal > 0 ? {
      sampled: true,
      sampleSize: maculaResult.sampleSize,
      sampleLimit: maculaResult.sampleLimit,
      fullCharge: sampledOnline,
      noneCharge: sampledCash,
      onlineRate: Math.round((sampledOnline / sampledTotal) * 1000) / 10,
    } : null,
    revenueByCurrency: {},
    priorRevenueByCurrency: {},
    currencyDailyTrends: {},
    revenueStatus: 'METRICS_UNAVAILABLE',
    lastUpdated: maculaResult.checkedAt || checkedAt,
    primarySource: 'MACULA_OMS',
    saleor: {
      status: saleorResult.status,
      live: saleorResult.live === true,
      orders: Number.isFinite(saleorResult.orders) ? saleorResult.orders : null,
      previousOrders: Number.isFinite(saleorResult.previousOrders) ? saleorResult.previousOrders : null,
      source: 'Saleor diagnostic only; not used for primary dashboard KPIs',
      checkedAt: saleorResult.checkedAt || saleorResult.lastUpdated || checkedAt,
    },
    gatewayCounts: null,
    methodCounts: null,
    sampledGatewayCounts: omsLive ? maculaResult.gatewayCounts : null,
    sampledMethodCounts: omsLive ? maculaResult.methodCounts : null,
    gatewaySample: omsLive ? { status: 'SAMPLED', size: maculaResult.sampleSize, limit: maculaResult.sampleLimit } : null,
    syncDeltaTrend: [],
    reconciliation: {
      status: matchedOrders !== null ? 'ORDER_ID_MATCHED' : 'METRICS_UNAVAILABLE',
      matchedOrderIds: matchedOrders !== null,
      saleorCohortOrders: saleorIds?.size ?? null,
      receivedInMacula: matchedOrders,
      missingFromMacula: saleorIds && matchedOrders !== null ? saleorIds.size - matchedOrders : null,
      maculaOutsideSaleorCohort: maculaIds && matchedOrders !== null ? maculaIds.size - matchedOrders : null,
      priorReceivedInMacula: priorMatchedOrders,
      checkedAt,
    },
    oms: {
      status: maculaResult.status, live: omsLive, noChannel: Boolean(maculaResult.noChannel), orders: omsOrders, previousOrders: omsPrior,
      changePct: omsChangePct, exceptions: null, todaySoFar: omsLive ? maculaResult.todaySoFar : null, dailyPoints: omsLive ? maculaResult.dailyPoints || [] : [],
      checkedAt: maculaResult.checkedAt || checkedAt, source: omsLive ? 'Macula OMS read-only search API' : 'Macula OMS unavailable; no Saleor values substituted',
      error: maculaResult.error,
    },
  }
}

export async function handleApiRequest(req, res) {
  const urlObj = new URL(req.url, `http://localhost:${config.port}`)
  const pathname = urlObj.pathname
  if (!GET_ROUTES.has(pathname) && !POST_ROUTES.has(pathname)) return false
  if (!applyCors(req, res)) { sendJson(res, { status: 'ERROR', error: 'Origin is not allowed.' }, 403); return true }
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true }
  const methodAllowed = (GET_ROUTES.has(pathname) && req.method === 'GET') || (POST_ROUTES.has(pathname) && req.method === 'POST')
  if (!methodAllowed) { res.setHeader('Allow', GET_ROUTES.has(pathname) ? 'GET, OPTIONS' : 'POST, OPTIONS'); sendJson(res, { status: 'ERROR', error: 'Method not allowed.' }, 405); return true }

  const authStatus = authConfigurationStatus()
  if (!authStatus.configured) {
    sendJson(res, { status: 'ERROR', authenticated: false, error: 'Dashboard authentication is not configured.', missing: authStatus.missing }, 503)
    return true
  }

  if (pathname === '/api/commerce/auth/login') {
    const limit = loginRateLimit(req)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      sendJson(res, { status: 'ERROR', authenticated: false, error: 'Too many login attempts. Try again later.' }, 429)
      return true
    }
    let body
    try { body = await readJsonBody(req, 8 * 1024) } catch { sendJson(res, { status: 'ERROR', authenticated: false, error: 'Invalid login request.' }, 400); return true }
    const user = typeof body.username === 'string' ? await authenticateUser(body.username, body.password) : null
    if (!user) {
      limit.recordFailure()
      await recordAuditLog(body.username, 'LOGIN_FAILED', body.username, {}, req.socket?.remoteAddress)
      sendJson(res, { status: 'ERROR', authenticated: false, error: 'Invalid username or password.' }, 401)
      return true
    }
    limit.clear()
    const rememberMe = Boolean(body.rememberMe)
    const timeoutSeconds = getSessionTimeoutSeconds(rememberMe)
    const now = Date.now()
    setSessionCookie(req, res, createSessionToken(user.username, user.role, now, { rememberMe }), timeoutSeconds)
    await recordAuditLog(user.username, 'LOGIN_SUCCESS', user.username, { role: user.role }, req.socket?.remoteAddress)
    sendJson(res, { status: 'OK', authenticated: true, username: user.username, role: user.role, permissions: user.permissions, expiresAt: now + timeoutSeconds * 1000, timeoutSeconds })
    return true
  }

  const session = getRequestSession(req)
  if (pathname === '/api/commerce/auth/logout') {
    clearSessionCookie(req, res)
    await recordAuditLog(session?.username, 'LOGOUT', session?.username, {}, req.socket?.remoteAddress)
    sendJson(res, { status: 'OK', authenticated: false })
    return true
  }
  if (!session) {
    clearSessionCookie(req, res)
    sendJson(res, { status: 'ERROR', authenticated: false, error: 'Your session has expired. Sign in again.' }, 401)
    return true
  }
  if (pathname === '/api/commerce/auth/session') {
    sendJson(res, { status: 'OK', authenticated: true, username: session.username, role: session.role, permissions: session.permissions, expiresAt: session.expiresAt, timeoutSeconds: session.timeoutSeconds ?? config.auth.sessionTimeoutSeconds })
    return true
  }
  if (pathname === '/api/commerce/auth/activity') {
    const refreshed = refreshSession(req, res, session)
    sendJson(res, { status: 'OK', authenticated: true, username: refreshed.username, role: refreshed.role, permissions: session.permissions, expiresAt: refreshed.expiresAt, timeoutSeconds: refreshed.timeoutSeconds ?? config.auth.sessionTimeoutSeconds })
    return true
  }

  if (!canAccessPath(session.role, pathname, session.permissions)) {
    sendJson(res, { status: 'ERROR', error: session.role === 'admin' ? 'Administrator access is required.' : 'Your account does not have permission to access this module.' }, 403)
    return true
  }

  if (pathname === '/api/commerce/auth/users') {
    if (req.method === 'GET') {
      let managed
      try {
        const users = await readManagedUsersAsync({ strict: true })
        managed = users.map(({ username, role, permissions }) => ({ username, role, permissions, managed: true }))
      } catch {
        sendJson(res, { status: 'ERROR', error: MANAGED_USER_STORAGE_ERROR }, 500)
        return true
      }
      const environment = [
        { username: config.auth.adminUsername, role: 'admin', managed: false },
        config.auth.viewerUsername && config.auth.viewerPasswordHash ? { username: config.auth.viewerUsername, role: 'viewer', permissions: DEFAULT_VIEWER_PERMISSIONS, managed: false } : null,
      ].filter(Boolean)
      sendJson(res, { status: 'OK', users: [...environment, ...managed] })
      return true
    }
    let body
    try { body = await readJsonBody(req, 8 * 1024) } catch { sendJson(res, { status: 'ERROR', error: 'Invalid user-management request.' }, 400); return true }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, { status: 'ERROR', error: 'Invalid user-management request.' }, 400)
      return true
    }
    if (body.action === 'permissions') {
      if (!validateManagedUsername(body.username) || !validateViewerPermissions(body.permissions)) {
        sendJson(res, { status: 'ERROR', error: 'Provide a valid username and module permissions.' }, 400)
        return true
      }
      try {
        const updated = await updateManagedViewerPermissions(body.username, body.permissions)
        if (!updated) { sendJson(res, { status: 'ERROR', error: 'Viewer account was not found.' }, 404); return true }
        await recordAuditLog(session.username, 'UPDATE_PERMISSIONS', body.username, { permissions: body.permissions }, req.socket?.remoteAddress)
        sendJson(res, { status: 'OK', updated: true })
      } catch (error) {
        const message = error instanceof TypeError ? error.message : MANAGED_USER_STORAGE_ERROR
        sendJson(res, { status: 'ERROR', error: message }, error instanceof TypeError ? 400 : 500)
      }
      return true
    }
    if (body.action === 'delete') {
      if (!validateManagedUsername(body.username)) { sendJson(res, { status: 'ERROR', error: 'Invalid username.' }, 400); return true }
      try {
        const deleted = await deleteManagedViewer(body.username)
        if (!deleted) { sendJson(res, { status: 'ERROR', error: 'Viewer account was not found.' }, 404); return true }
        await recordAuditLog(session.username, 'DELETE_USER', body.username, {}, req.socket?.remoteAddress)
        sendJson(res, { status: 'OK', deleted: true })
      } catch { sendJson(res, { status: 'ERROR', error: MANAGED_USER_STORAGE_ERROR }, 500) }
      return true
    }
    if (body.action !== 'save' || !validateManagedUsername(body.username) || typeof body.password !== 'string' || body.password.length < 12) {
      sendJson(res, { status: 'ERROR', error: 'Provide a valid username and a password of at least 12 characters.' }, 400)
      return true
    }
    if (body.username === config.auth.adminUsername || body.username === config.auth.viewerUsername) {
      sendJson(res, { status: 'ERROR', error: 'Environment-managed accounts cannot be changed here.' }, 409)
      return true
    }
    try {
      if (body.permissions !== undefined && !validateViewerPermissions(body.permissions)) {
        sendJson(res, { status: 'ERROR', error: 'Select valid viewer permissions.' }, 400)
        return true
      }
      const user = await saveManagedViewer(body.username, await hashPassword(body.password), body.permissions, body.role)
      await recordAuditLog(session.username, 'SAVE_USER', body.username, { role: user.role, permissions: user.permissions }, req.socket?.remoteAddress)
      sendJson(res, { status: 'OK', user })
    } catch (error) {
      const message = error instanceof TypeError ? error.message : MANAGED_USER_STORAGE_ERROR
      sendJson(res, { status: 'ERROR', error: message }, error instanceof TypeError ? 400 : 500)
    }
    return true
  }

  if (pathname === '/api/commerce/health') { sendJson(res, healthPayload()); return true }

  if (pathname === '/api/commerce/orders/summary') {
    const options = {
      brand: urlObj.searchParams.get('brand') || 'all', country: urlObj.searchParams.get('country') || 'all',
      start: urlObj.searchParams.get('start'), end: urlObj.searchParams.get('end'), tz: urlObj.searchParams.get('tz') || 'Dubai',
    }
    const cacheKey = JSON.stringify(options)
    const cached = queryCache.get(cacheKey)
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) { sendJson(res, { ...cached.data, cache: { hit: true, cachedAt: cached.cachedAt } }); return true }
    try {
      const [saleorResult, maculaResult] = await Promise.all([fetchSaleorSummary(options), fetchMaculaSummary(options)])
      const checkedAt = new Date().toISOString()
       const data = buildUnifiedOrders(saleorResult, maculaResult, checkedAt, options)
      queryCache.set(cacheKey, { time: Date.now(), cachedAt: checkedAt, data })
      sendJson(res, data)
    } catch (error) { sendJson(res, { status: 'ERROR', error: redactError(error) }, 500) }
    return true
  }

  try {
    if (pathname === '/api/commerce/gateways/telemetry') { sendJson(res, await fetchGatewayTelemetry()); return true }
    if (pathname === '/api/commerce/traffic/edge') { sendJson(res, await fetchTrafficTelemetry({ start: urlObj.searchParams.get('start'), end: urlObj.searchParams.get('end') })); return true }
    if (pathname === '/api/commerce/infra/apm') { sendJson(res, await fetchInfraTelemetry({ start: urlObj.searchParams.get('start'), end: urlObj.searchParams.get('end') })); return true }
    if (pathname === '/api/commerce/analytics/summary') { sendJson(res, await fetchAnalyticsSummary({ start: urlObj.searchParams.get('start'), end: urlObj.searchParams.get('end') })); return true }
    if (pathname === '/api/commerce/assistant/query') { sendJson(res, await answerCommerceQuestion(await readJsonBody(req))); return true }
    if (pathname === '/api/commerce/alerts/evaluate') {
      const parsed = await readJsonBody(req)
      sendJson(res, { status: 'COMPLETE', result: await evaluateAlertRule({ ...parsed, notifyTeams: false, notifyEmail: false }, parsed.currentMetrics || {}) })
      return true
    }
  } catch (error) {
    const message = redactError(error)
    const statusCode = /too large/i.test(message) ? 413 : /valid JSON|valid date window|enter a question/i.test(message) ? 400 : 500
    sendJson(res, { status: 'ERROR', error: statusCode === 500 ? 'Request failed. Check connector status and retry.' : message }, statusCode)
    return true
  }
  return false
}
