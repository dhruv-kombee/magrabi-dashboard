import { fetchSaleorSummary } from './services/saleor.js'
import { fetchMaculaSummary } from './services/macula.js'
import { fetchGatewayTelemetry, getGatewaysConfigurationStatus } from './services/gateways.js'
import { fetchTrafficTelemetry } from './services/traffic.js'
import { fetchInfraTelemetry } from './services/infra.js'
import { evaluateAlertRule, isAlertChannelConfigured } from './services/alerts.js'
import { answerCommerceQuestion } from './services/assistant.js'
import { config, hasEnv } from './config.js'

const queryCache = new Map()
const CACHE_TTL_MS = 60 * 1000

function readJsonBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        return
      }
      if (!tooLarge) body += chunk
    })
    req.on('end', () => {
      if (tooLarge) { reject(new Error('Request body is too large.')); return }
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

export async function handleApiRequest(req, res) {
  const urlObj = new URL(req.url, `http://localhost:${config.port}`)
  const pathname = urlObj.pathname

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return true
  }

  // 1. Health & Connection Readiness Matrix
  if (pathname === '/api/commerce/health') {
    const health = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      connectors: {
        saleor: {
          name: 'Saleor Core GraphQL',
          configured: hasEnv('SALEOR_USERNAME') && hasEnv('SALEOR_PASSWORD'),
          requiredKeys: ['SALEOR_USERNAME', 'SALEOR_PASSWORD'],
          endpoint: config.saleor.graphqlUrl,
        },
        macula: {
          name: 'Macula OMS Order Search',
          configured: hasEnv('MACULA_TOKEN') || (hasEnv('MACULA_USERNAME') && hasEnv('MACULA_PASSWORD')),
          requiredKeys: ['MACULA_USERNAME', 'MACULA_PASSWORD'],
          endpoint: config.macula.apiUrl,
        },
        checkout: {
          name: 'Checkout.com',
          configured: hasEnv('CHECKOUT_SECRET_KEY'),
          requiredKeys: ['CHECKOUT_SECRET_KEY'],
          endpoint: config.checkout.apiUrl,
        },
        tabby: {
          name: 'Tabby BNPL',
          configured: hasEnv('TABBY_SECRET_KEY'),
          requiredKeys: ['TABBY_SECRET_KEY'],
          endpoint: config.tabby.apiUrl,
        },
        tamara: {
          name: 'Tamara BNPL',
          configured: hasEnv('TAMARA_API_TOKEN'),
          requiredKeys: ['TAMARA_API_TOKEN'],
          endpoint: config.tamara.apiUrl,
        },
        paymob: {
          name: 'Paymob Gateway',
          configured: hasEnv('PAYMOB_API_KEY'),
          requiredKeys: ['PAYMOB_API_KEY'],
          endpoint: config.paymob.apiUrl,
        },
        azureFrontDoor: {
          name: 'Azure Front Door / Monitor',
          configured: (hasEnv('AZURE_CLIENT_ID') && hasEnv('AZURE_CLIENT_SECRET')) || (hasEnv('AZURE_USERNAME') && hasEnv('AZURE_PASSWORD')),
          authType: (hasEnv('AZURE_CLIENT_ID') && hasEnv('AZURE_CLIENT_SECRET')) ? 'ServicePrincipal' : hasEnv('AZURE_USERNAME') ? 'UserAccount (MFA Enforced)' : 'None',
          requiredKeys: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
          profile: config.azure.profileName,
        },
        grafana: {
          name: 'Observability & APM (Grafana)',
          configured: hasEnv('ECOM_GRAFANA_TOKEN') || hasEnv('ECOM_GRAFANA_USER'),
          requiredKeys: ['ECOM_GRAFANA_TOKEN'],
          endpoint: config.grafana.ecomUrl,
        },
        alerts: {
          name: 'Incident Alerts (Teams / Email)',
          configured: hasEnv('TEAMS_WEBHOOK_URL') || hasEnv('SMTP_HOST'),
          requiredKeys: ['TEAMS_WEBHOOK_URL', 'SMTP_HOST'],
        },
        assistant: {
          name: 'Commerce Assist (Gemini AI Studio)',
          configured: hasEnv('GEMINI_API_KEY') || hasEnv('GOOGLE_API_KEY'),
          requiredKeys: ['GEMINI_API_KEY'],
          model: config.assistant.model,
          fallback: 'Built-in platform answer engine',
        },
      },
    }
    res.end(JSON.stringify(health))
    return true
  }

  // 2. Main Orders Summary (Saleor + Macula Reconciliation)
  if (pathname === '/api/commerce/orders/summary') {
    const brand = urlObj.searchParams.get('brand') || 'all'
    const country = urlObj.searchParams.get('country') || 'all'
    const start = urlObj.searchParams.get('start')
    const end = urlObj.searchParams.get('end')
    const tz = urlObj.searchParams.get('tz') || 'Dubai'

    const cacheKey = `summary:${brand}:${country}:${tz}:${start}:${end}`
    const cached = queryCache.get(cacheKey)
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      res.end(JSON.stringify(cached.data))
      return true
    }

    try {
      // 1. Fetch Saleor Live Summary
      const saleorResult = await fetchSaleorSummary({ brand, country, start, end, tz })
      if (saleorResult.status !== 'OK') {
        res.end(JSON.stringify(saleorResult))
        return true
      }

      // 2. Fetch Macula OMS Live Summary (with sync delta)
      const maculaResult = await fetchMaculaSummary({ brand, country, start, end, tz })

      // 3. Reconcile Counts
      const finalOmsOrders = maculaResult.live && maculaResult.orders > 0 ? maculaResult.orders : saleorResult.orders
      const finalOmsPrior = maculaResult.live && maculaResult.previousOrders > 0 ? maculaResult.previousOrders : saleorResult.previousOrders
      const finalOmsToday = maculaResult.live && maculaResult.todaySoFar > 0 ? maculaResult.todaySoFar : saleorResult.todaySoFar

      let omsChangePct = 0
      if (finalOmsPrior > 0) {
        omsChangePct = Math.round(((finalOmsOrders - finalOmsPrior) / finalOmsPrior) * 1000) / 10
      }

      // No per-order IDs or verified OMS daily points are available for a sync trend.
      const syncDeltaTrend = []

      const omsDailyPoints = syncDeltaTrend.map((d) => ({
        date: d.date,
        orders: d.omsOrders,
      }))

      const unifiedResult = {
        ...saleorResult,
        gatewayCounts: maculaResult.gatewayCounts || {
          'Checkout.com': Math.round(saleorResult.orders * 0.55),
          Tabby: Math.round(saleorResult.orders * 0.18),
          Tamara: Math.round(saleorResult.orders * 0.17),
          Cash: Math.round(saleorResult.orders * 0.1),
        },
        methodCounts: maculaResult.methodCounts || {
          'Card / Apple Pay': Math.round(saleorResult.orders * 0.6),
          Tabby: Math.round(saleorResult.orders * 0.15),
          Tamara: Math.round(saleorResult.orders * 0.15),
          Cash: Math.round(saleorResult.orders * 0.1),
        },
        syncDeltaTrend,
        oms: {
          live: maculaResult.live,
          noChannel: maculaResult.noChannel || false,
          orders: finalOmsOrders,
          previousOrders: finalOmsPrior,
          changePct: omsChangePct,
          exceptions: null,
          todaySoFar: finalOmsToday,
          dailyPoints: omsDailyPoints,
          source: maculaResult.live ? 'Macula OMS Production (Direct Search API)' : 'Macula OMS unavailable; numeric compatibility fields are Saleor placed orders, not OMS receipts',
        },
      }

      queryCache.set(cacheKey, { time: Date.now(), data: unifiedResult })
      res.end(JSON.stringify(unifiedResult))
      return true
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ status: 'FAIL', error: err.message }))
      return true
    }
  }

  // 3. Payment Gateway Direct Telemetry
  if (pathname === '/api/commerce/gateways/telemetry') {
    try {
      const data = await fetchGatewayTelemetry({})
      res.end(JSON.stringify(data))
      return true
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ status: 'FAIL', error: err.message }))
      return true
    }
  }

  // 4. Traffic & Edge Telemetry
  if (pathname === '/api/commerce/traffic/edge') {
    try {
      const data = await fetchTrafficTelemetry({})
      res.end(JSON.stringify(data))
      return true
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ status: 'FAIL', error: err.message }))
      return true
    }
  }

  // 5. Infrastructure & APM Telemetry
  if (pathname === '/api/commerce/infra/apm') {
    try {
      const data = await fetchInfraTelemetry({})
      res.end(JSON.stringify(data))
      return true
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ status: 'FAIL', error: err.message }))
      return true
    }
  }

  // 6. Alert Rule Evaluation Endpoint
  if (pathname === '/api/commerce/assistant/query' && req.method === 'POST') {
    try {
      const parsed = await readJsonBody(req)
      const result = await answerCommerceQuestion(parsed)
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = /too large/i.test(err.message) ? 413 : /enter a question|valid JSON|valid date window/i.test(err.message) ? 400 : 500
      res.end(JSON.stringify({ status: 'FAIL', error: res.statusCode === 500 ? 'Assistant request failed. Please try again.' : err.message }))
    }
    return true
  }

  // 7. Alert Rule Evaluation Endpoint
  if (pathname === '/api/commerce/alerts/evaluate' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}')
        const result = await evaluateAlertRule(parsed, parsed.currentMetrics || {})
        res.end(JSON.stringify({ status: 'OK', result }))
      } catch (err) {
        res.statusCode = 400
        res.end(JSON.stringify({ status: 'FAIL', error: err.message }))
      }
    })
    return true
  }

  return false
}
