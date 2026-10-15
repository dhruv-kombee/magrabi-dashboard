import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// Channel mappings for Saleor GraphQL
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

// Channel group mappings for Macula OMS
const MACULA_CHANNEL_MAP: Record<string, string> = {
  'Magrabi:SA': '653a0168f66d966a3c6c06f2',
  'Magrabi:AE': '653a00431aaf66e6cf160938',
  'DoctorM:SA': '6672d9e544576401df250127',
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

function getMaculaChannelGroups(brand: string, country: string): string[] {
  if (brand === 'all' && country === 'all') return []
  const groups: string[] = []
  for (const [key, cgId] of Object.entries(MACULA_CHANNEL_MAP)) {
    const [b, c] = key.split(':')
    const matchBrand = brand === 'all' || brand.toLowerCase() === b.toLowerCase()
    const matchCountry = country === 'all' || country.toUpperCase() === c.toUpperCase()
    if (matchBrand && matchCountry) {
      groups.push(cgId)
    }
  }
  return groups
}

async function fetchMaculaCount(
  token: string,
  fromDate: string,
  toDate: string,
  channelGroups: string[],
): Promise<number> {
  const url = 'https://macula-api.magrabi.com/api/v1/order/search'
  if (!channelGroups || channelGroups.length === 0) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({ page: 1, limit: 1, fromDate, toDate }),
    })
    if (!res.ok) return 0
    const data = (await res.json()) as any
    return typeof data.totalElements === 'number' ? data.totalElements : 0
  }

  const counts = await Promise.all(
    channelGroups.map(async (cg) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({ page: 1, limit: 1, fromDate, toDate, channelGroup: cg }),
      })
      if (!res.ok) return 0
      const data = (await res.json()) as any
      return typeof data.totalElements === 'number' ? data.totalElements : 0
    }),
  )
  return counts.reduce((a, b) => a + b, 0)
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
          const startParam = urlObj.searchParams.get('start')
          const endParam = urlObj.searchParams.get('end')

          const now = new Date()
          let startDate: Date
          let endDate: Date

          if (startParam && endParam && !isNaN(Number(startParam)) && !isNaN(Number(endParam))) {
            startDate = new Date(Number(startParam))
            endDate = new Date(Number(endParam))
          } else {
            // Default to yesterday
            const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
            startDate = yesterday
            endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
          }

          const duration = Math.max(86400000, endDate.getTime() - startDate.getTime())
          const prevStartDate = new Date(startDate.getTime() - duration)
          const prevEndDate = new Date(startDate.getTime())

          // Format date strings for Saleor (gte, lte dates)
          const currStartStr = startDate.toISOString().split('T')[0]
          const currEndStr = new Date(endDate.getTime() - 1000).toISOString().split('T')[0]
          const prevStartStr = prevStartDate.toISOString().split('T')[0]
          const prevEndStr = new Date(prevEndDate.getTime() - 1000).toISOString().split('T')[0]
          const todayStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().split('T')[0]

          // Format ISO strings for Macula
          const currFromIso = startDate.toISOString()
          const currToIso = new Date(endDate.getTime() - 1).toISOString()
          const prevFromIso = prevStartDate.toISOString()
          const prevToIso = new Date(prevEndDate.getTime() - 1).toISOString()
          const todayFromIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
          const todayToIso = now.toISOString()

          const channelIds = getChannelIds(brand, country)
          const maculaChannelGroups = getMaculaChannelGroups(brand, country)

          const cacheKey = `${brand}:${country}:${currStartStr}:${currEndStr}:${maculaChannelGroups.join(',')}`
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
                variables: { email, password },
              }),
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
                    'User-Agent': 'Mozilla/5.0',
                  },
                  body: JSON.stringify([{ username: maculaEnv.MACULA_USERNAME, password: maculaEnv.MACULA_PASSWORD }]),
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

          // 3. Query Saleor
          const query = `
            query GetOrdersSummary($current: DateRangeInput, $prior: DateRangeInput, $today: DateRangeInput, $channels: [ID!]) {
              current: orders(first: 1, filter: { created: $current, channels: $channels }) {
                totalCount
              }
              prior: orders(first: 1, filter: { created: $prior, channels: $channels }) {
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
              Authorization: `Bearer ${cachedToken}`,
            },
            body: JSON.stringify({
              query,
              variables: {
                current: { gte: currStartStr, lte: currEndStr },
                prior: { gte: prevStartStr, lte: prevEndStr },
                today: { gte: todayStr, lte: todayStr },
                channels: channelIds.length > 0 ? channelIds : undefined,
              },
            }),
          })

          const orderJson = (await orderRes.json()) as any
          const currOrders = orderJson.data?.current?.totalCount ?? 0
          const priorOrders = orderJson.data?.prior?.totalCount ?? 0
          const todayOrders = orderJson.data?.today?.totalCount ?? 0

          let changePct = 0
          if (priorOrders > 0) {
            changePct = Math.round(((currOrders - priorOrders) / priorOrders) * 1000) / 10
          }

          // 4. Query Macula OMS
          let omsOrders = 0
          let omsPreviousOrders = 0
          let omsTodaySoFar = 0
          let omsLive = false

          if (cachedMaculaToken) {
            try {
              const [resCurr, resPrior, resToday] = await Promise.all([
                fetchMaculaCount(cachedMaculaToken, currFromIso, currToIso, maculaChannelGroups),
                fetchMaculaCount(cachedMaculaToken, prevFromIso, prevToIso, maculaChannelGroups),
                fetchMaculaCount(cachedMaculaToken, todayFromIso, todayToIso, maculaChannelGroups),
              ])

              omsOrders = resCurr
              omsPreviousOrders = resPrior
              omsTodaySoFar = resToday
              omsLive = true
            } catch (omsErr) {
              console.error('Macula search error:', omsErr)
            }
          }

          let omsChangePct = 0
          if (omsPreviousOrders > 0) {
            omsChangePct = Math.round(((omsOrders - omsPreviousOrders) / omsPreviousOrders) * 1000) / 10
          }
          const syncExceptions = Math.max(0, currOrders - omsOrders)

          const numDays = Math.max(1, Math.round(duration / 86400000))
          const periodDesc = numDays === 1 ? `1 day (${currStartStr})` : `${numDays} days (${currStartStr} to ${currEndStr})`

          const result = {
            status: 'OK',
            live: true,
            source: 'Saleor & Macula OMS Production',
            brand,
            country,
            channelsMatched: channelIds.length,
            period: periodDesc,
            startDate: currStartStr,
            endDate: currEndStr,
            orders: currOrders,
            previousOrders: priorOrders,
            changePct,
            todaySoFar: todayOrders,
            oms: {
              live: omsLive,
              orders: omsOrders,
              previousOrders: omsPreviousOrders,
              changePct: omsChangePct,
              exceptions: syncExceptions,
              todaySoFar: omsTodaySoFar,
              source: 'Macula OMS Production (https://macula-api.magrabi.com/)',
            },
            lastUpdated: new Date().toISOString(),
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

