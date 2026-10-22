import { config, hasEnv } from '../config.js'

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
    const authRes = await fetch(graphqlUrl, {
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
    })

    const authJson = await authRes.json()
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
    console.error('Saleor token renewal error:', err.message)
  }
  return null
}

export function isSaleorConfigured() {
  return hasEnv('SALEOR_USERNAME') && hasEnv('SALEOR_PASSWORD')
}

export async function fetchSaleorSummary(options) {
  const { brand = 'all', country = 'all', start, end, tz = 'Dubai' } = options

  if (!isSaleorConfigured()) {
    return {
      status: 'PENDING_CONFIG',
      live: false,
      missing: ['SALEOR_USERNAME', 'SALEOR_PASSWORD'],
      message: 'Saleor credentials not configured in environment (.env). Provide SALEOR_USERNAME and SALEOR_PASSWORD to activate live orders feed.',
    }
  }

  const authResult = await getOrRefreshToken()
  if (!authResult || typeof authResult !== 'string') {
    const errorMsg = authResult?.error || 'Saleor authentication failed. Please verify credentials in .env.'
    return {
      status: 'AUTH_REQUIRED',
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

  // Generate day strings (up to 31 days)
  const dayList = []
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
    const res = await fetch(config.saleor.graphqlUrl, {
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
    })
    return await res.json()
  }

  let orderJson = await sendQuery(token)

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
    if (refreshedToken) {
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

  const currentNodes = (orderJson.data?.recentOrders?.edges || []).map((e) => e.node)
  const inCurrentWindow = currentNodes.filter((o) => {
    const t = Date.parse(o.created)
    return t >= startDate.getTime() && t <= endDate.getTime()
  })

  const priorNodes = (orderJson.data?.priorOrdersSample?.edges || []).map((e) => e.node)
  const inPriorWindow = priorNodes.filter((o) => {
    const t = Date.parse(o.created)
    return t >= prevStartDate.getTime() && t <= prevEndDate.getTime()
  })

  const inTodayNodes = currentNodes.filter((o) => {
    const t = Date.parse(o.created)
    return t >= todayStartUtc && t <= now.getTime()
  })

  const numDays = Math.max(1, Math.round(duration / 86400000))

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
  const currOrders = numDays <= 2 ? inCurrentWindow.length : sumDailyOrders
  const priorOrders = numDays <= 2 ? inPriorWindow.length : (orderJson.data?.priorSummary?.totalCount ?? inPriorWindow.length)
  const todayOrders = inTodayNodes.length > 0 ? inTodayNodes.length : (orderJson.data?.todaySummary?.totalCount ?? 0)

  let changePct = 0
  if (priorOrders > 0) {
    changePct = Math.round(((currOrders - priorOrders) / priorOrders) * 1000) / 10
  }

  // Country Breakdown
  let countryBreakdown
  let priorCountryBreakdown

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

  // Multi-country Daily Points
  const countryDailyPoints = { SA: [], AE: [], EG: [], QA: [], KW: [] }
  const codes = ['SA', 'AE', 'EG', 'QA', 'KW']
  const totalWindowOrders = Math.max(1, currOrders)

  for (const dp of dailyPoints) {
    let dayRemaining = dp.orders
    const countryDayMap = {}

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

  // Payment Breakdown
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

  // Gross Revenue by Currency
  const revenueByCurrency = {}
  for (const o of (numDays <= 2 ? inCurrentWindow : currentNodes)) {
    const cur = o.total?.gross?.currency || o.channel?.currencyCode || 'AED'
    const amt = o.total?.gross?.amount || 0
    revenueByCurrency[cur] = Math.round(((revenueByCurrency[cur] || 0) + amt) * 100) / 100
  }

  const priorRevenueByCurrency = {}
  for (const o of (numDays <= 2 ? inPriorWindow : priorNodes)) {
    const cur = o.total?.gross?.currency || o.channel?.currencyCode || 'AED'
    const amt = o.total?.gross?.amount || 0
    priorRevenueByCurrency[cur] = Math.round(((priorRevenueByCurrency[cur] || 0) + amt) * 100) / 100
  }

  // Intraday Hourly Run-Rate Points (00:00 to 23:00)
  // Computes cumulative & hourly pace for Today vs Yesterday vs Past Week baseline
  const currentHour = new Date(now.getTime() + tzOffset * 3600000).getUTCHours()
  const hourlyPoints = []
  let cumulativeToday = 0
  let cumulativeYesterday = 0
  let cumulativeBaseline = 0

  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`
    
    // Calculate orders that fell into this hour today from loaded nodes
    const hourOrdersToday = inTodayNodes.filter((o) => {
      const oDate = new Date(Date.parse(o.created) + tzOffset * 3600000)
      return oDate.getUTCHours() === h
    }).length

    // Estimated pacing curve weights for historical comparison
    const hourWeight = [1, 1, 1, 1, 1, 2, 3, 5, 6, 7, 8, 8, 7, 6, 6, 6, 7, 8, 9, 8, 7, 5, 3, 2][h] / 100
    const yesterdayEst = Math.max(0, Math.round(priorOrders * hourWeight))
    const baselineEst = Math.max(0, Math.round(priorOrders * 1.05 * hourWeight))

    if (h <= currentHour) {
      cumulativeToday += hourOrdersToday
    }
    cumulativeYesterday += yesterdayEst
    cumulativeBaseline += baselineEst

    hourlyPoints.push({
      hour: h,
      label,
      todayHourly: h <= currentHour ? hourOrdersToday : null,
      todayCumulative: h <= currentHour ? cumulativeToday : null,
      yesterdayHourly: yesterdayEst,
      yesterdayCumulative: cumulativeYesterday,
      baselineCumulative: cumulativeBaseline,
    })
  }

  // Currency Time-Series Trends
  const currencyDailyTrends = {}
  for (const [cur, totalAmt] of Object.entries(revenueByCurrency)) {
    currencyDailyTrends[cur] = dailyPoints.map((dp) => {
      const share = currOrders > 0 ? dp.orders / currOrders : 0
      return {
        date: dp.date,
        revenue: Math.round(totalAmt * share * 100) / 100,
        orders: dp.orders,
      }
    })
  }

  let windowComparisonLabel = `previous ${numDays} days`
  if (numDays === 1) windowComparisonLabel = 'previous day'
  else if (numDays >= 6 && numDays <= 8) windowComparisonLabel = 'previous week'
  else if (numDays >= 13 && numDays <= 16) windowComparisonLabel = 'previous 2 weeks'
  else if (numDays >= 28 && numDays <= 32) windowComparisonLabel = 'previous month'

  const periodDesc = numDays === 1 ? `1 day (${currStartStr})` : `${numDays} days (${currStartStr} to ${currEndStr})`

  return {
    status: 'OK',
    live: true,
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
    currencyDailyTrends,
    lastUpdated: new Date().toISOString(),
  }
}
