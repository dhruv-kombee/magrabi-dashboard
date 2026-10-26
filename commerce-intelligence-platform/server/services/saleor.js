import { config, hasEnv } from '../config.js'
import { connectorError, fetchJson, redactError } from './http.js'

export const SALEOR_CHANNEL_MAP = {
  'Magrabi:AE': 'Q2hhbm5lbDox', // magrabi-ae-web
  'Magrabi:SA': 'Q2hhbm5lbDoy', // magrabi-sa-web
  'Magrabi:QA': 'Q2hhbm5lbDoz', // magrabi-qa-web
  'Magrabi:KW': 'Q2hhbm5lbDo0', // magrabi-kw-web
  'Magrabi:EG': 'Q2hhbm5lbDo1', // magrabi-eg-web
  'DoctorM:AE': 'Q2hhbm5lbDo2', // doctorm-ae-web
  'DoctorM:SA': 'Q2hhbm5lbDo3', // doctorm-sa-web
  'DoctorM:EG': 'Q2hhbm5lbDo4', // doctorm-eg-web
}

export function getChannelIds(brand, country) {
  const ids = []
  for (const [key, chId] of Object.entries(SALEOR_CHANNEL_MAP)) {
    const [b, c] = key.split(':')
    const matchBrand = brand === 'all' || brand.toLowerCase() === b.toLowerCase()
    const matchCountry = country === 'all' || country.toUpperCase() === c.toUpperCase()
    if (matchBrand && matchCountry) {
      ids.push(chId)
    }
  }
  return ids
}

let cachedToken = null
let tokenExpiry = 0

export async function getOrRefreshToken(force = false) {
  if (!force && cachedToken && Date.now() < tokenExpiry) {
    return cachedToken
  }

  const { graphqlUrl, username, password } = config.saleor
  if (!username || !password) {
    return null
  }

  try {
    const { response: authRes, payload: authJson } = await fetchJson(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `mutation TokenCreate($email: String!, $password: String!) {
          tokenCreate(email: $email, password: $password) {
            token
            errors { message }
          }
        }`,
        variables: { email: username, password },
      }),
    }, config.requestTimeoutMs)
    if (!authRes.ok || !authJson || typeof authJson !== 'object') return { error: `Authentication returned HTTP ${authRes.status}.` }
    const errors = authJson.data?.tokenCreate?.errors
    if (errors && errors.length > 0) {
      console.warn('[Saleor Auth Error]:', errors[0]?.message || 'Auth error')
      return { error: errors[0]?.message || 'Account inactive or invalid' }
    }
    const token = authJson.data?.tokenCreate?.token || null
    if (token) {
      cachedToken = token
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'))
        tokenExpiry = payload.exp ? payload.exp * 1000 - 90000 : Date.now() + 8 * 60 * 1000
      } catch {
        tokenExpiry = Date.now() + 8 * 60 * 1000
      }
      return cachedToken
    }
  } catch (err) {
    console.error('Saleor token renewal error:', redactError(err))
  }
  return null
}

export function isSaleorConfigured() {
  return hasEnv('SALEOR_USERNAME') && hasEnv('SALEOR_PASSWORD')
}

async function fetchAllOrderDetails(authToken, created, channels) {
  const nodes = []
  let after = null
  for (let page = 0; page < config.saleor.maxRevenuePages; page += 1) {
    const query = `query OrderDetails($created: DateRangeInput, $channels: [ID!], $after: String) {
      orders(first: 100, after: $after, filter: { created: $created, channels: $channels }) {
        edges { node { id number created chargeStatus channel { id slug currencyCode } total { gross { amount currency } } } }
        pageInfo { hasNextPage endCursor }
      }
    }`
    const { response, payload } = await fetchJson(config.saleor.graphqlUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ query, variables: { created, channels: channels.length ? channels : undefined, after } }),
    }, config.requestTimeoutMs)
    if (!response.ok) throw new Error(`Saleor order detail query returned HTTP ${response.status}.`)
    if (payload?.errors?.length) throw new Error(payload.errors[0]?.message || 'Saleor order detail query failed.')
    const connection = payload?.data?.orders
    if (!Array.isArray(connection?.edges) || typeof connection?.pageInfo?.hasNextPage !== 'boolean') throw new Error('Saleor order detail response is missing edges or pageInfo.')
    nodes.push(...connection.edges.map((edge) => edge.node).filter(Boolean))
    if (!connection.pageInfo.hasNextPage) return { nodes, complete: true }
    if (!connection.pageInfo.endCursor) throw new Error('Saleor pagination cursor is missing.')
    after = connection.pageInfo.endCursor
  }
  return { nodes, complete: false }
}

export async function fetchSaleorSummary(options) {
  const { brand = 'all', country = 'all', start, end, tz = 'Dubai' } = options

  if (!isSaleorConfigured()) {
    return {
      status: 'NOT_CONFIGURED',
      configured: false,
      live: false,
      missing: ['SALEOR_USERNAME', 'SALEOR_PASSWORD'],
      message: 'Saleor credentials not configured in environment (.env). Provide SALEOR_USERNAME and SALEOR_PASSWORD to activate live orders feed.',
    }
  }

  const authResult = await getOrRefreshToken()
  if (!authResult || typeof authResult !== 'string') {
    const errorMsg = authResult?.error || 'Saleor authentication failed. Please verify credentials in .env.'
    return {
      status: 'AUTHENTICATION_FAILED',
      configured: true,
      live: false,
      error: `Saleor Auth: ${errorMsg}`,
      message: 'Please update SALEOR_USERNAME / SALEOR_PASSWORD in .env with an active account.',
    }
  }
  const token = authResult

  const tzOffsets = { UTC: 0, Dubai: 4, IST: 5.5 }
  const tzOffset = tzOffsets[tz] ?? 4
  const now = new Date()

  let startDate
  let endDate
  if (start && end && !isNaN(Number(start)) && !isNaN(Number(end))) {
    startDate = new Date(Number(start))
    endDate = new Date(Number(end))
  } else {
    const nowMs = now.getTime()
    const tzShift = tzOffset * 3600000
    const zonedNow = new Date(nowMs + tzShift)
    const todayStartUtc = Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate()) - tzShift
    startDate = new Date(todayStartUtc)
    endDate = now
  }

  const duration = Math.max(86400000, endDate.getTime() - startDate.getTime())
  const prevStartDate = new Date(startDate.getTime() - duration)
  const prevEndDate = new Date(endDate.getTime() - duration)

  const formatDateInTz = (d) => {
    const shifted = new Date(d.getTime() + tzOffset * 3600000)
    return shifted.toISOString().split('T')[0]
  }

  const currStartStr = formatDateInTz(startDate)
  let currEndStr = formatDateInTz(endDate)
  if (currEndStr < currStartStr) currEndStr = currStartStr

  const prevStartStr = formatDateInTz(prevStartDate)
  let prevEndStr = formatDateInTz(prevEndDate)
  if (prevEndStr < prevStartStr) prevEndStr = prevStartStr

  const tzShift = tzOffset * 3600000
  const zonedNow = new Date(now.getTime() + tzShift)
  const todayStartUtc = Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate()) - tzShift
  const todayStr = formatDateInTz(now)

  const channelIds = getChannelIds(brand, country)

  // Generate adaptive date buckets (1 day for <=90 days, 3 days for <=180 days, weekly for >180 days)
  const sD = new Date(currStartStr)
  const eD = new Date(currEndStr)
  const totalDays = Math.max(1, Math.round((eD.getTime() - sD.getTime()) / 86400000) + 1)
  const intervalDays = totalDays <= 90 ? 1 : totalDays <= 180 ? 3 : 7

  const bucketList = []
  let currBucketDate = new Date(sD)
  let bIdx = 0

  while (currBucketDate <= eD && bucketList.length < 95) {
    const bStartStr = currBucketDate.toISOString().split('T')[0]
    const bEnd = new Date(currBucketDate)
    bEnd.setDate(bEnd.getDate() + intervalDays - 1)
    if (bEnd > eD) bEnd.setTime(eD.getTime())
    const bEndStr = bEnd.toISOString().split('T')[0]

    bucketList.push({
      idx: bIdx,
      date: bStartStr,
      endDate: bEndStr,
      alias: `day_${bIdx}: orders(first: 1, filter: { created: { gte: "${bStartStr}", lte: "${bEndStr}" }, channels: $channels }) { totalCount }`,
    })

    currBucketDate.setDate(currBucketDate.getDate() + intervalDays)
    bIdx++
  }

  const dayAliases = bucketList.map((b) => b.alias).join('\n')
  const dayList = bucketList.map((b) => b.date)

  const countryChannels = {
    SA: getChannelIds(brand, 'SA'),
    AE: getChannelIds(brand, 'AE'),
    EG: getChannelIds(brand, 'EG'),
    QA: getChannelIds(brand, 'QA'),
    KW: getChannelIds(brand, 'KW'),
  }

  const activeCountryQueries = []
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

  const saleorCurrGte = startDate.toISOString().split('T')[0]
  const saleorCurrLte = endDate.toISOString().split('T')[0]
  const saleorPriorGte = prevStartDate.toISOString().split('T')[0]
  const saleorPriorLte = prevEndDate.toISOString().split('T')[0]
  const saleorTodayGte = new Date(todayStartUtc).toISOString().split('T')[0]
  const saleorTodayLte = now.toISOString().split('T')[0]

  const sendQuery = async (authToken) => {
    const { response: res, payload } = await fetchJson(config.saleor.graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
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
    }, config.requestTimeoutMs)
    if (!res.ok) throw new Error(`Saleor GraphQL returned HTTP ${res.status}.`)
    if (!payload || typeof payload !== 'object') throw new Error('Saleor GraphQL response is malformed.')
    return payload
  }

  let orderJson
  let queryToken = token
  try {
    orderJson = await sendQuery(token)
  } catch (error) {
    return { ...connectorError(error), configured: true, live: false, source: 'Saleor Core GraphQL', checkedAt: new Date().toISOString() }
  }

  // Auto-refresh token if expired
  if (
    orderJson.errors &&
    orderJson.errors.some(
      (e) =>
        typeof e.message === 'string' &&
        (e.message.toLowerCase().includes('expired') || e.message.toLowerCase().includes('token')),
    )
  ) {
    const refreshedToken = await getOrRefreshToken(true)
    if (typeof refreshedToken === 'string') {
      queryToken = refreshedToken
      orderJson = await sendQuery(refreshedToken)
    }
  }

  if (orderJson.errors && !orderJson.data?.currentSummary && !orderJson.data?.recentOrders) {
    return {
      status: 'FAIL',
      live: false,
      error: orderJson.errors[0]?.message || 'Saleor query failed',
    }
  }

  let detailCurrent = { nodes: (orderJson.data?.recentOrders?.edges || []).map((e) => e.node), complete: false }
  let detailPrior = { nodes: (orderJson.data?.priorOrdersSample?.edges || []).map((e) => e.node), complete: false }
  try {
    ;[detailCurrent, detailPrior] = await Promise.all([
      fetchAllOrderDetails(queryToken, { gte: saleorCurrGte, lte: saleorCurrLte }, channelIds),
      fetchAllOrderDetails(queryToken, { gte: saleorPriorGte, lte: saleorPriorLte }, channelIds),
    ])
  } catch (error) {
    console.error('Saleor detail pagination error:', redactError(error))
  }
  const currentNodes = detailCurrent.nodes
  const inCurrentWindow = currentNodes.filter((o) => {
    const t = Date.parse(o.created)
    return t >= startDate.getTime() && t <= endDate.getTime()
  })

  const priorNodes = detailPrior.nodes
  const inPriorWindow = priorNodes.filter((o) => {
    const t = Date.parse(o.created)
    return t >= prevStartDate.getTime() && t <= prevEndDate.getTime()
  })

  const inTodayNodes = currentNodes.filter((o) => {
    const t = Date.parse(o.created)
    return t >= todayStartUtc && t <= now.getTime()
  })

  const numDays = Math.max(1, Math.round(duration / 86400000))

  let dailyPoints = bucketList.map((b) => {
    if (b.date === todayStr && inTodayNodes.length > 0 && intervalDays === 1) {
      return { date: b.date, orders: inTodayNodes.length }
    }
    return {
      date: b.date,
      endDate: b.endDate !== b.date ? b.endDate : undefined,
      orders: orderJson.data?.[`day_${b.idx}`]?.totalCount ?? 0,
    }
  })

  const authoritativeCurrOrders = orderJson.data?.currentSummary?.totalCount ?? 0
  const authoritativePriorOrders = orderJson.data?.priorSummary?.totalCount ?? 0

  if (typeof orderJson.data?.currentSummary?.totalCount !== 'number' || typeof orderJson.data?.priorSummary?.totalCount !== 'number' || typeof orderJson.data?.todaySummary?.totalCount !== 'number') {
    return { status: 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING', configured: true, live: true, source: 'Saleor Core GraphQL', error: 'Order totals are missing from the GraphQL response.', checkedAt: new Date().toISOString() }
  }
  const currOrders = detailCurrent.complete ? inCurrentWindow.length : authoritativeCurrOrders
  const priorOrders = detailPrior.complete ? inPriorWindow.length : authoritativePriorOrders
  const todayOrders = orderJson.data.todaySummary.totalCount

  if (detailCurrent.complete) {
    dailyPoints = bucketList.map((bucket) => ({
      date: bucket.date,
      endDate: bucket.endDate !== bucket.date ? bucket.endDate : undefined,
      orders: inCurrentWindow.filter((order) => {
        const date = formatDateInTz(new Date(order.created))
        return date >= bucket.date && date <= bucket.endDate
      }).length,
    }))
  }

  let changePct = 0
  if (priorOrders > 0) {
    changePct = Math.round(((currOrders - priorOrders) / priorOrders) * 1000) / 10
  }

  // Country Breakdown
  let countryBreakdown
  let priorCountryBreakdown

  if (detailCurrent.complete && detailPrior.complete) {
    const empty = () => ({ SA: 0, AE: 0, EG: 0, QA: 0, KW: 0 })
    const group = (nodes) => {
      const result = empty()
      for (const order of nodes) {
        const slug = order.channel?.slug || ''
        const code = ['SA', 'AE', 'EG', 'QA', 'KW'].find((candidate) => slug.includes(`-${candidate.toLowerCase()}-`))
        if (code) result[code] += 1
      }
      return result
    }
    countryBreakdown = group(inCurrentWindow)
    priorCountryBreakdown = group(inPriorWindow)
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

  // Multi-country Daily Points
  const countryDailyPoints = {}
  if (detailCurrent.complete) {
    for (const code of ['SA', 'AE', 'EG', 'QA', 'KW']) countryDailyPoints[code] = dailyPoints.map((point) => ({ date: point.date, orders: 0 }))
    for (const order of inCurrentWindow) {
      const date = formatDateInTz(new Date(order.created))
      const slug = order.channel?.slug || ''
      const code = ['SA', 'AE', 'EG', 'QA', 'KW'].find((candidate) => slug.includes(`-${candidate.toLowerCase()}-`))
      const bucketIndex = dailyPoints.findIndex((item) => date >= item.date && date <= (item.endDate || item.date))
      const point = code && bucketIndex >= 0 ? countryDailyPoints[code]?.[bucketIndex] : null
      if (point) point.orders += 1
    }
  }

  // Payment Breakdown
  let fullCharge = 0
  let noneCharge = 0
  let priorFullCharge = 0
  let priorNoneCharge = 0

  if (detailCurrent.complete && detailPrior.complete) {
    fullCharge = inCurrentWindow.filter((order) => order.chargeStatus === 'FULL').length
    noneCharge = inCurrentWindow.length - fullCharge
    priorFullCharge = inPriorWindow.filter((order) => order.chargeStatus === 'FULL').length
    priorNoneCharge = inPriorWindow.length - priorFullCharge
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

  // Gross Revenue by Currency
  // For short windows (<= 2 days), compute directly from filtered nodes.
  // For multi-month ranges, scale currency sample AOV by channel volume.
  const revenueByCurrency = {}
  const sampleCountsByCur = {}
  const sampleSumsByCur = {}

  const relevantNodes = numDays <= 2 ? inCurrentWindow : currentNodes
  for (const o of relevantNodes) {
    const cur = o.total?.gross?.currency || o.channel?.currencyCode || 'AED'
    const amt = o.total?.gross?.amount || 0
    sampleCountsByCur[cur] = (sampleCountsByCur[cur] || 0) + 1
    sampleSumsByCur[cur] = (sampleSumsByCur[cur] || 0) + amt
  }

  const currentRevenueComplete = detailCurrent.complete && inCurrentWindow.length === currOrders
  if (currentRevenueComplete) {
    for (const [cur, amt] of Object.entries(sampleSumsByCur)) {
      revenueByCurrency[cur] = Math.round(amt * 100) / 100
    }
  }

  const priorRevenueByCurrency = {}
  const priorSampleCountsByCur = {}
  const priorSampleSumsByCur = {}

  const relevantPriorNodes = numDays <= 2 ? inPriorWindow : priorNodes
  for (const o of relevantPriorNodes) {
    const cur = o.total?.gross?.currency || o.channel?.currencyCode || 'AED'
    const amt = o.total?.gross?.amount || 0
    priorSampleCountsByCur[cur] = (priorSampleCountsByCur[cur] || 0) + 1
    priorSampleSumsByCur[cur] = (priorSampleSumsByCur[cur] || 0) + amt
  }

  const priorRevenueComplete = detailPrior.complete && inPriorWindow.length === priorOrders
  if (priorRevenueComplete) {
    for (const [cur, amt] of Object.entries(priorSampleSumsByCur)) {
      priorRevenueByCurrency[cur] = Math.round(amt * 100) / 100
    }
  }

  // Intraday Hourly Run-Rate Points (00:00 to 23:00)
  // Computes cumulative & hourly pace for Today vs Yesterday vs Past Week baseline
  const currentHour = new Date(now.getTime() + tzOffset * 3600000).getUTCHours()
  const hourlyPoints = []
  let cumulativeToday = 0

  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`
    
    // Calculate orders that fell into this hour today from loaded nodes
    const hourOrdersToday = inTodayNodes.filter((o) => {
      const oDate = new Date(Date.parse(o.created) + tzOffset * 3600000)
      return oDate.getUTCHours() === h
    }).length

    if (h <= currentHour) {
      cumulativeToday += hourOrdersToday
    }
    hourlyPoints.push({
      hour: h,
      label,
      todayHourly: h <= currentHour ? hourOrdersToday : null,
      todayCumulative: h <= currentHour ? cumulativeToday : null,
      yesterdayHourly: null,
      yesterdayCumulative: null,
      baselineCumulative: null,
    })
  }

  // Currency Time-Series Trends
  const currencyDailyTrends = {}
  if (currentRevenueComplete) {
    for (const order of inCurrentWindow) {
      const currency = order.total?.gross?.currency || order.channel?.currencyCode
      const amount = Number(order.total?.gross?.amount)
      if (!currency || !Number.isFinite(amount)) continue
      currencyDailyTrends[currency] ||= []
      const date = formatDateInTz(new Date(order.created))
      let point = currencyDailyTrends[currency].find((item) => item.date === date)
      if (!point) { point = { date, revenue: 0, orders: 0 }; currencyDailyTrends[currency].push(point) }
      point.revenue = Math.round((point.revenue + amount) * 100) / 100
      point.orders += 1
    }
    for (const points of Object.values(currencyDailyTrends)) points.sort((a, b) => a.date.localeCompare(b.date))
  }

  let windowComparisonLabel = `previous ${numDays} days`
  if (numDays === 1) windowComparisonLabel = 'previous day'
  else if (numDays >= 6 && numDays <= 8) windowComparisonLabel = 'previous week'
  else if (numDays >= 13 && numDays <= 16) windowComparisonLabel = 'previous 2 weeks'
  else if (numDays >= 28 && numDays <= 32) windowComparisonLabel = 'previous month'

  const periodDesc = numDays === 1 ? `1 day (${currStartStr})` : `${numDays} days (${currStartStr} to ${currEndStr})`

  return {
    status: 'OK',
    configured: true,
    live: true,
    metricsAvailable: true,
    source: 'Saleor Core GraphQL (Live Orders Feed)',
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
    hourlyPoints,
    countryDailyPoints,
    countryBreakdown,
    priorCountryBreakdown,
    paymentBreakdown,
    revenueByCurrency,
    priorRevenueByCurrency,
    revenueStatus: currentRevenueComplete ? 'LIVE_VERIFIED' : 'METRICS_UNAVAILABLE',
    revenueSample: currentRevenueComplete ? null : { sampledOrders: currentNodes.length, totalOrders: currOrders, valuesByCurrency: sampleSumsByCur },
    currencyDailyTrends,
    lastUpdated: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
  }
}
