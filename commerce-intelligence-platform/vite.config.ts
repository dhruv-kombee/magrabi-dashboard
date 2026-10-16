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
  'Magrabi:EG': '653a02b4b7a633308ae36572',
  'Magrabi:QA': '653a054812c9e0c020beafd9',
  'DoctorM:SA': '6672d9e544576401df250127',
  'DoctorM:AE': '6780c217db39c395607fb906',
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

          const tz = urlObj.searchParams.get('tz') || 'Dubai'
          const tzOffsets: Record<string, number> = { UTC: 0, Dubai: 4, IST: 5.5 }
          const tzOffset = tzOffsets[tz] ?? 4

          if (startParam && endParam && !isNaN(Number(startParam)) && !isNaN(Number(endParam))) {
            startDate = new Date(Number(startParam))
            endDate = new Date(Number(endParam))
          } else {
            // Default to today in target timezone (Dubai)
            const nowMs = now.getTime()
            const tzShift = tzOffset * 3600000
            const zonedNow = new Date(nowMs + tzShift)
            const y = zonedNow.getUTCFullYear()
            const m = zonedNow.getUTCMonth()
            const d = zonedNow.getUTCDate()
            // start of today in target timezone
            const todayStartUtc = Date.UTC(y, m, d) - tzShift
            startDate = new Date(todayStartUtc)
            endDate = now
          }

          const duration = Math.max(86400000, endDate.getTime() - startDate.getTime())
          const prevStartDate = new Date(startDate.getTime() - duration)
          const prevEndDate = new Date(endDate.getTime() - duration)

          const formatDateInTz = (d: Date) => {
            const shifted = new Date(d.getTime() + tzOffset * 3600000)
            return shifted.toISOString().split('T')[0]
          }

          // Format date strings in reporting timezone
          const currStartStr = formatDateInTz(startDate)
          let currEndStr = formatDateInTz(endDate)
          if (currEndStr < currStartStr) {
            currEndStr = currStartStr
          }

          const prevStartStr = formatDateInTz(prevStartDate)
          let prevEndStr = formatDateInTz(prevEndDate)
          if (prevEndStr < prevStartStr) {
            prevEndStr = prevStartStr
          }

          // Start of today in reporting timezone
          const tzShift = tzOffset * 3600000
          const zonedNow = new Date(now.getTime() + tzShift)
          const todayStartUtc = Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate()) - tzShift
          const todayStr = formatDateInTz(now)

          // Format ISO strings for Macula OMS
          const currFromIso = startDate.toISOString()
          const currToIso = endDate.toISOString()
          const prevFromIso = prevStartDate.toISOString()
          const prevToIso = prevEndDate.toISOString()
          const todayFromIso = new Date(todayStartUtc).toISOString()
          const todayToIso = now.toISOString()

          const channelIds = getChannelIds(brand, country)
          const maculaChannelGroups = getMaculaChannelGroups(brand, country)

          // Cache key includes timezone to ensure no cross-timezone pollution
          const cacheKey = `${brand}:${country}:${tz}:${currStartStr}:${currEndStr}:${maculaChannelGroups.join(',')}`
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

          // 1. Authenticate with Saleor (auto-refresh before 10-min expiry)
          async function getOrRefreshToken(force = false): Promise<string | null> {
            if (!force && cachedToken && Date.now() < tokenExpiry) {
              return cachedToken
            }
            try {
              const authRes = await fetch(graphqlUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query: `mutation TokenCreate($email: String!, $password: String!) { tokenCreate(email: $email, password: $password) { token errors { message } } }`,
                  variables: { email, password },
                }),
              })
              const authJson = (await authRes.json()) as any
              const token = authJson.data?.tokenCreate?.token || null
              if (token) {
                cachedToken = token
                try {
                  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'))
                  // Refresh 90 seconds before real 10-minute expiry
                  tokenExpiry = payload.exp ? payload.exp * 1000 - 90000 : Date.now() + 8 * 60 * 1000
                } catch {
                  tokenExpiry = Date.now() + 8 * 60 * 1000
                }
                return cachedToken
              }
            } catch (err) {
              console.error('Saleor token error:', err)
            }
            return null
          }

          const activeToken = await getOrRefreshToken()
          if (!activeToken) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ status: 'FAIL', error: 'Saleor auth failed' }))
            return
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

          // Generate day strings for daily trend chart (up to 31 days)
          const dayList: string[] = []
          const sD = new Date(currStartStr)
          const eD = new Date(currEndStr)
          for (let d = new Date(sD); d <= eD && dayList.length < 31; d.setDate(d.getDate() + 1)) {
            dayList.push(d.toISOString().split('T')[0])
          }

          const dayAliases = dayList
            .map(
              (dStr, idx) =>
                `day_${idx}: orders(first: 1, filter: { created: { gte: "${dStr}", lte: "${dStr}" }, channels: $channels }) { totalCount }`,
            )
            .join('\n')

          const countryChannels: Record<string, string[]> = {
            SA: getChannelIds(brand, 'SA'),
            AE: getChannelIds(brand, 'AE'),
            EG: getChannelIds(brand, 'EG'),
            QA: getChannelIds(brand, 'QA'),
            KW: getChannelIds(brand, 'KW'),
          }

          const activeCountryQueries: string[] = []
          for (const [cCode, cChs] of Object.entries(countryChannels)) {
            if ((country === 'all' || country.toUpperCase() === cCode.toUpperCase()) && cChs.length > 0) {
              activeCountryQueries.push(
                `country_${cCode}: orders(first: 1, filter: { created: $current, channels: ${JSON.stringify(cChs)} }) { totalCount }`,
                `country_prior_${cCode}: orders(first: 1, filter: { created: $prior, channels: ${JSON.stringify(cChs)} }) { totalCount }`,
              )
            }
          }
          const countryAliases = activeCountryQueries.join('\n')

          const chargeAliases = `
            charge_FULL: orders(first: 1, filter: { created: $current, channels: $channels, chargeStatus: [FULL] }) { totalCount }
            charge_NONE: orders(first: 1, filter: { created: $current, channels: $channels, chargeStatus: [NONE] }) { totalCount }
            charge_prior_FULL: orders(first: 1, filter: { created: $prior, channels: $channels, chargeStatus: [FULL] }) { totalCount }
            charge_prior_NONE: orders(first: 1, filter: { created: $prior, channels: $channels, chargeStatus: [NONE] }) { totalCount }
          `

          const recentRevQuery = `
            recentOrders: orders(first: 100, filter: { created: $current, channels: $channels }) {
              edges {
                node {
                  id
                  number
                  created
                  chargeStatus
                  channel { id slug currencyCode }
                  total { gross { amount currency } }
                }
              }
            }
            priorOrdersSample: orders(first: 100, filter: { created: $prior, channels: $channels }) {
              edges {
                node {
                  id
                  number
                  created
                  chargeStatus
                  channel { id slug currencyCode }
                  total { gross { amount currency } }
                }
              }
            }
          `

          // 3. Query Saleor with full UTC date coverage
          const query = `
            query GetOrdersSummary($current: DateRangeInput, $prior: DateRangeInput, $today: DateRangeInput, $channels: [ID!]) {
              currentSummary: orders(first: 1, filter: { created: $current, channels: $channels }) {
                totalCount
              }
              priorSummary: orders(first: 1, filter: { created: $prior, channels: $channels }) {
                totalCount
              }
              todaySummary: orders(first: 1, filter: { created: $today, channels: $channels }) {
                totalCount
              }
              ${dayAliases}
              ${countryAliases}
              ${chargeAliases}
              ${recentRevQuery}
            }
          `

          // Ensure UTC date bounds cover the entirety of both current and prior windows without UTC cut-offs
          const saleorCurrGte = startDate.toISOString().split('T')[0]
          const saleorCurrLte = endDate.toISOString().split('T')[0]
          const saleorPriorGte = prevStartDate.toISOString().split('T')[0]
          const saleorPriorLte = prevEndDate.toISOString().split('T')[0]
          const saleorTodayGte = new Date(todayStartUtc).toISOString().split('T')[0]
          const saleorTodayLte = now.toISOString().split('T')[0]

          const sendOrderQuery = async (t: string) => {
            const res = await fetch(graphqlUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${t}`,
              },
              body: JSON.stringify({
                query,
                variables: {
                  current: { gte: saleorCurrGte, lte: saleorCurrLte },
                  prior: { gte: saleorPriorGte, lte: saleorPriorLte },
                  today: { gte: saleorTodayGte, lte: saleorTodayLte },
                  channels: channelIds.length > 0 ? channelIds : undefined,
                },
              }),
            })
            return (await res.json()) as any
          }

          let orderJson = await sendOrderQuery(activeToken)

          // Auto-refresh token if signature expired and retry once
          if (
            orderJson.errors &&
            orderJson.errors.some((e: any) =>
              typeof e.message === 'string' &&
              (e.message.toLowerCase().includes('expired') || e.message.toLowerCase().includes('signature') || e.message.toLowerCase().includes('token'))
            )
          ) {
            const refreshedToken = await getOrRefreshToken(true)
            if (refreshedToken) {
              orderJson = await sendOrderQuery(refreshedToken)
            }
          }

          if (orderJson.errors && !orderJson.data?.currentSummary && !orderJson.data?.recentOrders) {
            console.error('Saleor query failed with error:', orderJson.errors)
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ status: 'FAIL', error: orderJson.errors[0]?.message || 'Saleor query failed' }))
            return
          }

          // Exact millisecond timestamp filtering to eliminate timezone cut-off errors
          const currentNodes = (orderJson.data?.recentOrders?.edges || []).map((e: any) => e.node)
          const inCurrentWindow = currentNodes.filter((o: any) => {
            const t = Date.parse(o.created)
            return t >= startDate.getTime() && t <= endDate.getTime()
          })

          const priorNodes = (orderJson.data?.priorOrdersSample?.edges || []).map((e: any) => e.node)
          const inPriorWindow = priorNodes.filter((o: any) => {
            const t = Date.parse(o.created)
            return t >= prevStartDate.getTime() && t <= prevEndDate.getTime()
          })

          const inTodayNodes = currentNodes.filter((o: any) => {
            const t = Date.parse(o.created)
            return t >= todayStartUtc && t <= now.getTime()
          })

          const numDays = Math.max(1, Math.round(duration / 86400000))

          // Extract daily points with timezone awareness
          const dailyPoints = dayList.map((dStr, idx) => {
            if (dStr === todayStr && inTodayNodes.length > 0) {
              return { date: dStr, orders: inTodayNodes.length }
            }
            return {
              date: dStr,
              orders: orderJson.data?.[`day_${idx}`]?.totalCount ?? 0,
            }
          })

          const sumDailyOrders = dailyPoints.reduce((a, b) => a + b.orders, 0)
          let currOrders = numDays <= 2 ? inCurrentWindow.length : sumDailyOrders
          let priorOrders = numDays <= 2 ? inPriorWindow.length : (orderJson.data?.priorSummary?.totalCount ?? inPriorWindow.length)
          const todayOrders = inTodayNodes.length > 0 ? inTodayNodes.length : (orderJson.data?.todaySummary?.totalCount ?? 0)

          let changePct = 0
          if (priorOrders > 0) {
            changePct = Math.round(((currOrders - priorOrders) / priorOrders) * 1000) / 10
          }

          // Extract country breakdown
          let countryBreakdown: Record<string, number>
          let priorCountryBreakdown: Record<string, number>

          if (numDays <= 2) {
            countryBreakdown = { SA: 0, AE: 0, EG: 0, QA: 0, KW: 0 }
            for (const o of inCurrentWindow) {
              const slug = o.channel?.slug || ''
              if (slug.includes('-sa-')) countryBreakdown.SA++
              else if (slug.includes('-ae-')) countryBreakdown.AE++
              else if (slug.includes('-eg-')) countryBreakdown.EG++
              else if (slug.includes('-qa-')) countryBreakdown.QA++
              else if (slug.includes('-kw-')) countryBreakdown.KW++
            }

            priorCountryBreakdown = { SA: 0, AE: 0, EG: 0, QA: 0, KW: 0 }
            for (const o of inPriorWindow) {
              const slug = o.channel?.slug || ''
              if (slug.includes('-sa-')) priorCountryBreakdown.SA++
              else if (slug.includes('-ae-')) priorCountryBreakdown.AE++
              else if (slug.includes('-eg-')) priorCountryBreakdown.EG++
              else if (slug.includes('-qa-')) priorCountryBreakdown.QA++
              else if (slug.includes('-kw-')) priorCountryBreakdown.KW++
            }
          } else {
            countryBreakdown = {
              SA: orderJson.data?.country_SA?.totalCount ?? 0,
              AE: orderJson.data?.country_AE?.totalCount ?? 0,
              EG: orderJson.data?.country_EG?.totalCount ?? 0,
              QA: orderJson.data?.country_QA?.totalCount ?? 0,
              KW: orderJson.data?.country_KW?.totalCount ?? 0,
            }
            priorCountryBreakdown = {
              SA: orderJson.data?.country_prior_SA?.totalCount ?? 0,
              AE: orderJson.data?.country_prior_AE?.totalCount ?? 0,
              EG: orderJson.data?.country_prior_EG?.totalCount ?? 0,
              QA: orderJson.data?.country_prior_QA?.totalCount ?? 0,
              KW: orderJson.data?.country_prior_KW?.totalCount ?? 0,
            }
          }

          // Build countryDailyPoints for multi-line country trend charts
          const countryDailyPoints: Record<string, Array<{ date: string; orders: number }>> = {
            SA: [],
            AE: [],
            EG: [],
            QA: [],
            KW: [],
          }

          const codes = ['SA', 'AE', 'EG', 'QA', 'KW'] as const
          const totalWindowOrders = Math.max(1, currOrders)

          // Distribute day orders among countries based on validated country breakdown
          for (const dp of dailyPoints) {
            let dayRemaining = dp.orders
            const countryDayMap: Record<string, number> = {}

            // Assign proportional orders
            for (let i = 0; i < codes.length; i++) {
              const code = codes[i]
              if (i === codes.length - 1) {
                countryDayMap[code] = Math.max(0, dayRemaining)
              } else {
                const share = (countryBreakdown[code] || 0) / totalWindowOrders
                const val = Math.min(dayRemaining, Math.round(dp.orders * share))
                countryDayMap[code] = Math.max(0, val)
                dayRemaining -= val
              }
            }

            for (const code of codes) {
              countryDailyPoints[code].push({
                date: dp.date,
                orders: countryDayMap[code] ?? 0,
              })
            }
          }

          // Extract payment charges
          let fullCharge = 0
          let noneCharge = 0
          let priorFullCharge = 0
          let priorNoneCharge = 0

          if (numDays <= 2) {
            for (const o of inCurrentWindow) {
              if (o.chargeStatus === 'FULL') fullCharge++
              else noneCharge++
            }
            for (const o of inPriorWindow) {
              if (o.chargeStatus === 'FULL') priorFullCharge++
              else priorNoneCharge++
            }
          } else {
            fullCharge = orderJson.data?.charge_FULL?.totalCount ?? 0
            noneCharge = orderJson.data?.charge_NONE?.totalCount ?? 0
            priorFullCharge = orderJson.data?.charge_prior_FULL?.totalCount ?? 0
            priorNoneCharge = orderJson.data?.charge_prior_NONE?.totalCount ?? 0
          }

          const onlineRate = currOrders > 0 ? Math.round((fullCharge / currOrders) * 1000) / 10 : 0
          const priorOnlineRate = priorOrders > 0 ? Math.round((priorFullCharge / priorOrders) * 1000) / 10 : 0
          let paymentChangePct = 0
          if (priorOnlineRate > 0) {
            paymentChangePct = Math.round(((onlineRate - priorOnlineRate) / priorOnlineRate) * 1000) / 10
          }
          const paymentBreakdown = {
            fullCharge,
            noneCharge,
            onlineRate,
            priorFullCharge,
            priorNoneCharge,
            priorOnlineRate,
            changePct: paymentChangePct,
          }

          // Extract gross revenue by currency
          const revenueByCurrency: Record<string, number> = {}
          for (const o of (numDays <= 2 ? inCurrentWindow : currentNodes)) {
            const cur = o.total?.gross?.currency || o.channel?.currencyCode || 'AED'
            const amt = o.total?.gross?.amount || 0
            revenueByCurrency[cur] = Math.round(((revenueByCurrency[cur] || 0) + amt) * 100) / 100
          }

          const priorRevenueByCurrency: Record<string, number> = {}
          for (const o of (numDays <= 2 ? inPriorWindow : priorNodes)) {
            const cur = o.total?.gross?.currency || o.channel?.currencyCode || 'AED'
            const amt = o.total?.gross?.amount || 0
            priorRevenueByCurrency[cur] = Math.round(((priorRevenueByCurrency[cur] || 0) + amt) * 100) / 100
          }

          // 4. Query Macula OMS
          let omsOrders = 0
          let omsPreviousOrders = 0
          let omsTodaySoFar = 0
          let omsLive = false
          const gatewayCounts: Record<string, number> = {
            'Checkout.com': 0,
            Tabby: 0,
            Tamara: 0,
            Cash: 0,
          }
          const methodCounts: Record<string, number> = {
            'Card / Apple Pay': 0,
            Tabby: 0,
            Tamara: 0,
            Cash: 0,
          }

          const isFilteredSelection = brand !== 'all' || country !== 'all'
          const noMaculaChannel = isFilteredSelection && maculaChannelGroups.length === 0

          if (cachedMaculaToken && !noMaculaChannel) {
            try {
              const [resCurr, resPrior, resToday, resSample] = await Promise.all([
                fetchMaculaCount(cachedMaculaToken, currFromIso, currToIso, maculaChannelGroups),
                fetchMaculaCount(cachedMaculaToken, prevFromIso, prevToIso, maculaChannelGroups),
                fetchMaculaCount(cachedMaculaToken, todayFromIso, todayToIso, maculaChannelGroups),
                fetch('https://macula-api.magrabi.com/api/v1/order/search', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${cachedMaculaToken}`,
                    'User-Agent': 'Mozilla/5.0',
                  },
                  body: JSON.stringify({ page: 1, limit: 100, fromDate: currFromIso, toDate: currToIso }),
                })
                  .then((r) => (r.ok ? r.json() : null))
                  .catch(() => null) as any,
              ])

              omsOrders = resCurr
              omsPreviousOrders = resPrior
              omsTodaySoFar = resToday
              omsLive = true

              if (resSample && Array.isArray(resSample.content)) {
                for (const o of resSample.content) {
                  for (const p of o.payments || []) {
                    const b = (p.paymentBackendSystem || '').toLowerCase()
                    const pt = (p.paymentType || '').toLowerCase()
                    if (b.includes('checkout') || pt.includes('online')) {
                      gatewayCounts['Checkout.com']++
                      methodCounts['Card / Apple Pay']++
                    } else if (b.includes('tabby') || pt.includes('tabby')) {
                      gatewayCounts['Tabby']++
                      methodCounts['Tabby']++
                    } else if (b.includes('tamara') || pt.includes('tamara')) {
                      gatewayCounts['Tamara']++
                      methodCounts['Tamara']++
                    } else {
                      gatewayCounts['Cash']++
                      methodCounts['Cash']++
                    }
                  }
                }
              }
            } catch (omsErr) {
              console.error('Macula search error:', omsErr)
            }
          }

          let omsChangePct = 0
          if (omsPreviousOrders > 0) {
            omsChangePct = Math.round(((omsOrders - omsPreviousOrders) / omsPreviousOrders) * 1000) / 10
          }
          const syncExceptions = Math.max(0, currOrders - omsOrders)
          let windowComparisonLabel = `previous ${numDays} days`
          if (numDays === 1) {
            windowComparisonLabel = 'previous day'
          } else if (numDays >= 6 && numDays <= 8) {
            windowComparisonLabel = 'previous week'
          } else if (numDays >= 13 && numDays <= 16) {
            windowComparisonLabel = 'previous 2 weeks'
          } else if (numDays >= 28 && numDays <= 32) {
            windowComparisonLabel = 'previous month'
          }
          const periodDesc = numDays === 1 ? `1 day (${currStartStr})` : `${numDays} days (${currStartStr} to ${currEndStr})`

          const result = {
            status: 'OK',
            live: true,
            source: 'Saleor & Macula OMS Production',
            brand,
            country,
            channelsMatched: channelIds.length,
            period: periodDesc,
            windowDays: numDays,
            windowComparisonLabel,
            startDate: currStartStr,
            endDate: currEndStr,
            orders: currOrders,
            previousOrders: priorOrders,
            changePct,
            todaySoFar: todayOrders,
            dailyPoints,
            countryDailyPoints,
            countryBreakdown,
            priorCountryBreakdown,
            paymentBreakdown,
            revenueByCurrency,
            priorRevenueByCurrency,
            gatewayCounts,
            methodCounts,
            oms: {
              live: noMaculaChannel ? true : omsLive,
              noChannel: noMaculaChannel,
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

