import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// Channel mappings
const CHANNEL_MAP: Record<string, string> = {
  'Magrabi:AE': 'Q2hhbm5lbDox', // magrabi-ae-web
  'Magrabi:SA': 'Q2hhbm5lbDoy', // magrabi-sa-web
  'Magrabi:QA': 'Q2hhbm5lbDoz', // magrabi-qa-web
  'Magrabi:KW': 'Q2hhbm5lbDo0', // magrabi-kw-web
  'Magrabi:EG': 'Q2hhbm5lbDo1', // magrabi-eg-web
  'DoctorM:AE': 'Q2hhbm5lbDo2', // doctorm-ae-web
  'DoctorM:SA': 'Q2hhbm5lbDo3', // doctorm-sa-web
  'DoctorM:EG': 'Q2hhbm5lbDo4', // doctorm-eg-web
}

function getChannelIds(brand: string, country: string): string[] {
  const ids: string[] = []
  for (const [key, chId] of Object.entries(CHANNEL_MAP)) {
    const [b, c] = key.split(':')
    const matchBrand = brand === 'all' || brand.toLowerCase() === b.toLowerCase()
    const matchCountry = country === 'all' || country.toUpperCase() === c.toUpperCase()
    if (matchBrand && matchCountry) {
      ids.push(chId)
    }
  }
  return ids
}

function loadEnvFile(envPath: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (line && !line.startsWith('#') && line.includes('=')) {
        const [k, ...v] = line.split('=')
        env[k.trim()] = v.join('=').trim()
      }
    }
  }
  return env
}

// In-memory token and query cache
let cachedToken: string | null = null
let tokenExpiry = 0
let cachedMaculaToken: string | null = null
let maculaTokenExpiry = 0
const queryCache = new Map<string, { time: number; data: unknown }>()
const CACHE_TTL_MS = 60 * 1000

function saleorApiPlugin(): Plugin {
  return {
    name: 'saleor-api-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/commerce/orders/summary')) {
          return next()
        }

        try {
          const urlObj = new URL(req.url, 'http://localhost:5174')
          const brand = urlObj.searchParams.get('brand') || 'all'
          const country = urlObj.searchParams.get('country') || 'all'

          const cacheKey = `${brand}:${country}`
          const cached = queryCache.get(cacheKey)
          if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(cached.data))
            return
          }

          const secretsPath = path.resolve(import.meta.dirname, '../.secrets/saleor.env')
          const env = loadEnvFile(secretsPath)
          const graphqlUrl = env.SALEOR_GRAPHQL_URL || 'https://ecom-app-api.magrabi.com/graphql/'
          const email = env.SALEOR_USERNAME
          const password = env.SALEOR_PASSWORD

          if (!email || !password) {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ status: 'FAIL', error: 'Missing Saleor credentials in .secrets/saleor.env' }))
            return
          }

          // 1. Authenticate with Saleor if token expired
          if (!cachedToken || Date.now() > tokenExpiry) {
            const authRes = await fetch(graphqlUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: `mutation TokenCreate($email: String!, $password: String!) { tokenCreate(email: $email, password: $password) { token errors { message } } }`,
                variables: { email, password }
              })
            })
            const authJson = (await authRes.json()) as any
            cachedToken = authJson.data?.tokenCreate?.token || null
            if (!cachedToken) {
              res.statusCode = 401
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ status: 'FAIL', error: 'Saleor auth failed', details: authJson.data?.tokenCreate?.errors }))
              return
            }
            tokenExpiry = Date.now() + 20 * 60 * 1000 // 20 mins
          }

          // 2. Authenticate with Macula OMS if token expired
          const maculaSecretsPath = path.resolve(import.meta.dirname, '../.secrets/macula.env')
          const maculaEnv = loadEnvFile(maculaSecretsPath)
          if (maculaEnv.MACULA_USERNAME && maculaEnv.MACULA_PASSWORD) {
            if (!cachedMaculaToken || Date.now() > maculaTokenExpiry) {
              try {
                const maculaLoginRes = await fetch('https://macula-v2.magrabi.com/login', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Next-Action': '29b8e5cb66c119158096e1ad95d81e0ddb1c2d01',
                    Accept: 'text/x-component',
                    'User-Agent': 'Mozilla/5.0'
                  },
                  body: JSON.stringify([{ username: maculaEnv.MACULA_USERNAME, password: maculaEnv.MACULA_PASSWORD }])
                })
                const setCookie = maculaLoginRes.headers.get('set-cookie') || ''
                const tokenMatch = setCookie.match(/token=([^;]+)/)
                cachedMaculaToken = tokenMatch ? tokenMatch[1] : null
                if (cachedMaculaToken) {
                  maculaTokenExpiry = Date.now() + 20 * 60 * 1000
                }
              } catch (macErr) {
                console.error('Macula login error:', macErr)
              }
            }
          }

          const channelIds = getChannelIds(brand, country)

          // Compute UTC dates for Yesterday and Day Before
          const now = new Date()
          const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
          const dayBefore = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2))
          const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

          const yestStr = yesterday.toISOString().split('T')[0]
          const beforeStr = dayBefore.toISOString().split('T')[0]
          const todayStr = today.toISOString().split('T')[0]

          // 3. Query Saleor
          const query = `
            query GetOrdersSummary($yest: DateRangeInput, $before: DateRangeInput, $today: DateRangeInput, $channels: [ID!]) {
              yesterday: orders(first: 1, filter: { created: $yest, channels: $channels }) {
                totalCount
              }
              dayBefore: orders(first: 1, filter: { created: $before, channels: $channels }) {
                totalCount
              }
              today: orders(first: 1, filter: { created: $today, channels: $channels }) {
                totalCount
              }
            }
          `

          const orderRes = await fetch(graphqlUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cachedToken}`
            },
            body: JSON.stringify({
              query,
              variables: {
                yest: { gte: yestStr, lte: yestStr },
                before: { gte: beforeStr, lte: beforeStr },
                today: { gte: todayStr, lte: todayStr },
                channels: channelIds.length > 0 ? channelIds : undefined
              }
            })
          })

          const orderJson = (await orderRes.json()) as any
          const yestOrders = orderJson.data?.yesterday?.totalCount ?? 0
          const beforeOrders = orderJson.data?.dayBefore?.totalCount ?? 0
          const todayOrders = orderJson.data?.today?.totalCount ?? 0

          let changePct = 0
          if (beforeOrders > 0) {
            changePct = Math.round(((yestOrders - beforeOrders) / beforeOrders) * 1000) / 10
          }

          // 4. Query Macula OMS
          let omsOrders = 0
          let omsPreviousOrders = 0
          let omsTodaySoFar = 0
          let omsLive = false

          if (cachedMaculaToken) {
            try {
              const fromYest = `${yestStr}T00:00:00.000Z`
              const toYest = `${yestStr}T23:59:59.999Z`
              const fromBefore = `${beforeStr}T00:00:00.000Z`
              const toBefore = `${beforeStr}T23:59:59.999Z`
              const fromToday = `${todayStr}T00:00:00.000Z`
              const toToday = `${todayStr}T23:59:59.999Z`

              const [resYest, resBefore, resToday] = await Promise.all([
                fetch('https://macula-api.magrabi.com/api/v1/order/search', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${cachedMaculaToken}`,
                    'User-Agent': 'Mozilla/5.0'
                  },
                  body: JSON.stringify({ page: 1, limit: 1, fromDate: fromYest, toDate: toYest })
                }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any,
                fetch('https://macula-api.magrabi.com/api/v1/order/search', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${cachedMaculaToken}`,
                    'User-Agent': 'Mozilla/5.0'
                  },
                  body: JSON.stringify({ page: 1, limit: 1, fromDate: fromBefore, toDate: toBefore })
                }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any,
                fetch('https://macula-api.magrabi.com/api/v1/order/search', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${cachedMaculaToken}`,
                    'User-Agent': 'Mozilla/5.0'
                  },
                  body: JSON.stringify({ page: 1, limit: 1, fromDate: fromToday, toDate: toToday })
                }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any,
              ])

              if (resYest && typeof resYest.totalElements === 'number') {
                omsOrders = resYest.totalElements
                omsPreviousOrders = resBefore?.totalElements ?? 0
                omsTodaySoFar = resToday?.totalElements ?? 0
                omsLive = true
              }
            } catch (omsErr) {
              console.error('Macula search error:', omsErr)
            }
          }

          let omsChangePct = 0
          if (omsPreviousOrders > 0) {
            omsChangePct = Math.round(((omsOrders - omsPreviousOrders) / omsPreviousOrders) * 1000) / 10
          }
          const syncExceptions = Math.max(0, yestOrders - omsOrders)

          const result = {
            status: 'OK',
            live: true,
            source: 'Saleor & Macula OMS Production',
            brand,
            country,
            channelsMatched: channelIds.length,
            period: 'yesterday',
            date: yestStr,
            orders: yestOrders,
            previousOrders: beforeOrders,
            changePct,
            todaySoFar: todayOrders,
            oms: {
              live: omsLive,
              orders: omsOrders,
              previousOrders: omsPreviousOrders,
              changePct: omsChangePct,
              exceptions: syncExceptions,
              todaySoFar: omsTodaySoFar,
              source: 'Macula OMS Production (https://macula-api.magrabi.com/)'
            },
            lastUpdated: new Date().toISOString()
          }

          queryCache.set(cacheKey, { time: Date.now(), data: result })

          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (err: unknown) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          const msg = err instanceof Error ? err.message : 'Internal Server Error'
          res.end(JSON.stringify({ status: 'FAIL', error: msg }))
        }
      })
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), saleorApiPlugin()],
  server: {
    port: 5174,
    open: false,
  },
})

