import { config, hasEnv } from '../config.js'
import { connectorError, fetchJson, redactError } from './http.js'

export const MACULA_CHANNEL_MAP = {
  'Magrabi:SA': '653a0168f66d966a3c6c06f2',
  'Magrabi:AE': '653a00431aaf66e6cf160938',
  'Magrabi:EG': '653a02b4b7a633308ae36572',
  'Magrabi:QA': '653a054812c9e0c020beafd9',
  'Magrabi:KW': '66f40a88bc72e64691220a3e',
  'DoctorM:SA': '6672d9e544576401df250127',
  'DoctorM:AE': '6780c217db39c395607fb906',
  'DoctorM:EG': '69b7c3e6fd85bfc89267f961',
}

export function getMaculaChannelGroups(brand, country) {
  if (brand === 'all' && country === 'all') return []
  const groups = []
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

let cachedMaculaToken = null
let maculaTokenExpiry = 0

export async function getOrRefreshMaculaToken() {
  if (config.macula.token) {
    return config.macula.token
  }

  if (cachedMaculaToken && Date.now() < maculaTokenExpiry) {
    return cachedMaculaToken
  }

  const { username, password, dashboardUrl } = config.macula
  if (!username || !password) {
    return null
  }

  try {
    const { response: loginRes } = await fetchJson(dashboardUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': '29b8e5cb66c119158096e1ad95d81e0ddb1c2d01',
        Accept: 'text/x-component',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify([{ username, password }]),
    }, config.requestTimeoutMs)
    if (!loginRes.ok) return null

    const setCookie = loginRes.headers.get('set-cookie') || ''
    const tokenMatch = setCookie.match(/token=([^;]+)/)
    if (tokenMatch) {
      cachedMaculaToken = tokenMatch[1]
      maculaTokenExpiry = Date.now() + 20 * 60 * 1000
      return cachedMaculaToken
    }
  } catch (err) {
    console.error('Macula login error:', redactError(err))
  }
  return null
}

export function isMaculaConfigured() {
  return hasEnv('MACULA_TOKEN') || (hasEnv('MACULA_USERNAME') && hasEnv('MACULA_PASSWORD'))
}

async function fetchMaculaCount(token, fromDate, toDate, channelGroups) {
  const url = config.macula.apiUrl
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0',
  }

  if (!channelGroups || channelGroups.length === 0) {
    const { response: res, payload: data } = await fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page: 1, limit: 1, fromDate, toDate }),
    }, config.requestTimeoutMs)
    if (!res.ok) throw new Error(`Macula count request returned HTTP ${res.status}`)
    if (typeof data.totalElements !== 'number') throw new Error('Macula count response has no verified total')
    return data.totalElements
  }

  const counts = await Promise.all(
    channelGroups.map(async (cg) => {
      const { response: res, payload: data } = await fetchJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ page: 1, limit: 1, fromDate, toDate, channelGroup: cg }),
      }, config.requestTimeoutMs)
      if (!res.ok) throw new Error(`Macula channel count returned HTTP ${res.status}`)
      if (typeof data.totalElements !== 'number') throw new Error('Macula channel response has no verified total')
      return data.totalElements
    }),
  )
  return counts.reduce((a, b) => a + b, 0)
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function buildCountBuckets(startDate, endDate, tzOffset) {
  const totalDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000))
  const intervalDays = Math.max(1, Math.ceil(totalDays / 31))
  const buckets = []
  let cursor = startDate.getTime()
  while (cursor < endDate.getTime()) {
    const bucketEnd = Math.min(endDate.getTime(), cursor + intervalDays * 86_400_000)
    const label = new Date(cursor + tzOffset * 3_600_000).toISOString().slice(0, 10)
    buckets.push({ date: label, from: new Date(cursor).toISOString(), to: new Date(bucketEnd).toISOString() })
    cursor = bucketEnd
  }
  return buckets
}

export async function fetchMaculaSummary(options) {
  const { brand = 'all', country = 'all', start, end, tz = 'Dubai' } = options

  if (!isMaculaConfigured()) {
    return {
      status: 'NOT_CONFIGURED',
      configured: false,
      live: false,
      missing: ['MACULA_USERNAME', 'MACULA_PASSWORD'],
      message: 'Macula OMS credentials not configured in environment (.env). Provide MACULA_USERNAME/MACULA_PASSWORD to activate OMS fulfillment feed.',
    }
  }

  const token = await getOrRefreshMaculaToken()
  if (!token) {
    return {
      status: 'AUTHENTICATION_FAILED',
      configured: true,
      live: false,
      error: 'Macula OMS authentication failed. Verify credentials in .env.',
    }
  }

  const tzOffsets = { UTC: 0, Dubai: 4, IST: 5.5 }
  const tzOffset = tzOffsets[tz] ?? 4
  const now = new Date()

  let startDate
  let endDate
  if (start && end && !isNaN(Number(start)) && !isNaN(Number(end))) {
    startDate = new Date(Number(start))
    endDate = new Date(Number(end))
  } else {
    const tzShift = tzOffset * 3600000
    const zonedNow = new Date(now.getTime() + tzShift)
    const todayStartUtc = Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate()) - tzShift
    startDate = new Date(todayStartUtc)
    endDate = now
  }

  const duration = Math.max(86400000, endDate.getTime() - startDate.getTime())
  const prevStartDate = new Date(startDate.getTime() - duration)
  const prevEndDate = new Date(endDate.getTime() - duration)

  const tzShift = tzOffset * 3600000
  const zonedNow = new Date(now.getTime() + tzShift)
  const todayStartUtc = Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate()) - tzShift

  const currFromIso = startDate.toISOString()
  const currToIso = endDate.toISOString()
  const prevFromIso = prevStartDate.toISOString()
  const prevToIso = prevEndDate.toISOString()
  const todayFromIso = new Date(todayStartUtc).toISOString()
  const todayToIso = now.toISOString()

  const maculaChannelGroups = getMaculaChannelGroups(brand, country)
  const isFilteredSelection = brand !== 'all' || country !== 'all'
  const noMaculaChannel = isFilteredSelection && maculaChannelGroups.length === 0

  if (noMaculaChannel) {
    return {
      status: 'OK',
      configured: true,
      live: true,
      noChannel: true,
      orders: 0,
      previousOrders: 0,
      todaySoFar: 0,
      syncDeltaTrend: [],
      source: 'Macula OMS (No matching channel group)',
    }
  }

  const gatewayCounts = {
    'Checkout.com': 0,
    Tabby: 0,
    Tamara: 0,
    Cash: 0,
  }
  const methodCounts = {
    'Card / Apple Pay': 0,
    Tabby: 0,
    Tamara: 0,
    Cash: 0,
  }

  const countBuckets = buildCountBuckets(startDate, endDate, tzOffset)
  const countryCodes = country === 'all' ? ['SA', 'AE', 'EG', 'QA', 'KW'] : [country.toUpperCase()]

  try {
    const [resCurr, resPrior, resToday, resSample, dailyPoints, countryRows] = await Promise.all([
      fetchMaculaCount(token, currFromIso, currToIso, maculaChannelGroups),
      fetchMaculaCount(token, prevFromIso, prevToIso, maculaChannelGroups),
      fetchMaculaCount(token, todayFromIso, todayToIso, maculaChannelGroups),
      fetchJson(config.macula.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({ page: 1, limit: 100, fromDate: currFromIso, toDate: currToIso }),
      }, config.requestTimeoutMs).then(({ response, payload }) => response.ok ? payload : null),
      mapWithConcurrency(countBuckets, 5, async (bucket) => ({
        date: bucket.date,
        orders: await fetchMaculaCount(token, bucket.from, bucket.to, maculaChannelGroups),
      })),
      mapWithConcurrency(countryCodes, 5, async (code) => {
        const groups = getMaculaChannelGroups(brand, code)
        if (!groups.length) return { code, current: 0, prior: 0 }
        const [current, prior] = await Promise.all([
          fetchMaculaCount(token, currFromIso, currToIso, groups),
          fetchMaculaCount(token, prevFromIso, prevToIso, groups),
        ])
        return { code, current, prior }
      }),
    ])

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

    return {
      status: 'OK',
      configured: true,
      live: true,
      metricsAvailable: true,
      orders: resCurr,
      previousOrders: resPrior,
      todaySoFar: resToday,
      dailyPoints,
      countryBreakdown: Object.fromEntries(countryRows.map((row) => [row.code, row.current])),
      priorCountryBreakdown: Object.fromEntries(countryRows.map((row) => [row.code, row.prior])),
      gatewayCounts,
      methodCounts,
      gatewayCountsStatus: 'SAMPLED',
      methodCountsStatus: 'SAMPLED',
      sampleSize: Array.isArray(resSample?.content) ? resSample.content.length : 0,
      sampleLimit: 100,
      syncDeltaTrend: [],
      source: 'Macula OMS Production (Direct Search API)',
      checkedAt: new Date().toISOString(),
    }
  } catch (err) {
    console.error('Macula summary query error:', redactError(err))
    return {
      ...connectorError(err),
      configured: true,
      live: false,
      source: 'Macula OMS',
      checkedAt: new Date().toISOString(),
    }
  }
}
