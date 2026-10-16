import React, { useState, useMemo, useEffect } from 'react'
import { exportReport } from './exportReport'
import type {
  BrandFilter,
  CountryFilter,
  ErrorKind,
  SectionKey,
  TimezoneKey,
  TrafficSourceKey,
} from './types'
import {
  aggregate,
  countries,
  dayKey,
  filterRecords,
  fixtures,
  fixtureStart,
  fmt,
  formatTime,
  offsets,
  pct,
  sources,
  split,
  sum,
} from './fixtures'
import styles from './CommerceDashboard.module.css'
import { CustomDatePicker } from './CustomDatePicker'

const sectionConfig: Array<{ key: SectionKey; label: string; title: string; subtitle: string }> = [
  {
    key: 'overview',
    label: 'Overview',
    title: 'Commerce overview',
    subtitle: 'An aligned view of orders, payments and customer experience.',
  },
  {
    key: 'orders',
    label: 'Orders & payments',
    title: 'Orders & payments',
    subtitle: 'One canonical order count. Payment gateways and methods tracked separately.',
  },
  {
    key: 'journey',
    label: 'Customer journey',
    title: 'From first intent to confirmed order',
    subtitle: 'A proposed event-based funnel — not an estimate from surviving checkout records.',
  },
  {
    key: 'traffic',
    label: 'Traffic & errors',
    title: 'Traffic & error analysis',
    subtitle: 'Keep edge, origin and gateway counts separate. Investigate the request behind the signal.',
  },
  {
    key: 'infra',
    label: 'Infrastructure & APM',
    title: 'The systems behind the journey',
    subtitle: 'Service-level context: saturation, latency, dependencies and trace-level investigation.',
  },
  {
    key: 'sources',
    label: 'Data sources',
    title: 'A transparent data foundation',
    subtitle: 'What feeds each metric, what is missing, and what we need to connect.',
  },
  {
    key: 'alerts',
    label: 'Alerts & rules',
    title: 'Act on the right signal',
    subtitle: 'Thresholds, ownership and delivery routes — configurable without treating missing data as zero.',
  },
]

const sourceCatalog = [
  {
    name: 'OMS / downstream receipt',
    status: 'Live Production Connected',
    scope:
      'Orders received by OMS, fulfilment state and handoff exceptions — reconciled against Saleor orders placed.',
    need: 'Production API connected via macula-api.magrabi.com; orders and payments actively ingested.',
    owner: 'Macula OMS + backend',
    badgeText: '● LIVE PROD',
    isLive: true,
  },
  {
    name: 'Saleor / placed orders + payments',
    status: 'Live Production Connected',
    scope:
      'Authoritative order creation, country channels, charge status and revenue streams.',
    need: 'Production GraphQL connected via ecom-app-api.magrabi.com/graphql; queries active.',
    owner: 'Saleor Core + DevOps',
    badgeText: '● LIVE PROD',
    isLive: true,
  },
  {
    name: 'Payment gateways',
    status: 'Partial via OMS payments',
    scope: 'Checkout.com, Tabby, Tamara payment methods extracted from OMS order entities.',
    need: 'Direct provider webhooks for raw callback timing and gateway-side authorization latencies.',
    owner: 'Payment integration owners',
    badgeText: 'Partial (via OMS)',
    isLive: false,
  },
  {
    name: 'Azure Front Door / CDN / WAF',
    status: 'Technical source identified',
    scope: 'Separate edge request/status metrics and partial access/WAF investigation logs.',
    need: 'Scoped backend metrics reader; coverage checks and explicit shared-endpoint mappings.',
    owner: 'DevOps',
    badgeText: 'Connector pending',
  },
  {
    name: 'Grafana / Prometheus / Loki',
    status: 'Technical source identified',
    scope: 'Ingress status/latency, CPU/memory, pods, logs and backend exceptions.',
    need: 'Least-privilege server-side readers, bounded queries, caching and freshness metadata.',
    owner: 'DevOps',
    badgeText: 'Connector pending',
  },
  {
    name: 'Browser journey events',
    status: 'New instrumentation required',
    scope: 'Add-to-cart → confirmed order; pseudonymous event IDs, not raw form values.',
    need: 'Consent decisions, event schema, cohort definition, server confirmation and QA.',
    owner: 'Frontend + backend + privacy',
    badgeText: 'Events required',
  },
  {
    name: 'Sentry / distributed APM',
    status: 'Partial coverage to validate',
    scope: 'Exceptions, service traces, dependency timings and correlation links.',
    need: 'Verify quotas, sampling, SDK coverage, redaction and trace propagation.',
    owner: 'Developers + DevOps',
    badgeText: 'Coverage unverified',
  },
  {
    name: 'Clarity',
    status: 'Optional UX enrichment',
    scope: 'Aggregated UX and session context when permitted.',
    need: 'Cached scheduled export; official API limits 10 requests/project/day, prior 1–3 days, 1000 rows without pagination.',
    owner: 'Analytics / UX owner',
    badgeText: 'Optional · pending',
  },
  {
    name: 'GA4',
    status: 'Optional delayed analytics',
    scope: 'Acquisition and behavioural context; not the critical order ledger.',
    need: 'Standard intraday reports may lag 2–6 hours. Limited Realtime metrics are a few minutes behind.',
    owner: 'Analytics owner',
    badgeText: 'Optional · pending',
  },
]

const currencyMetadata: Record<
  string,
  { symbol: string; countryCode: string; name: string; nativeSymbol: string }
> = {
  AED: { symbol: 'AED', countryCode: 'AE', name: 'UAE Dirham', nativeSymbol: 'د.إ' },
  SAR: { symbol: 'SAR', countryCode: 'SA', name: 'Saudi Riyal', nativeSymbol: 'ر.س' },
  EGP: { symbol: 'EGP', countryCode: 'EG', name: 'Egyptian Pound', nativeSymbol: 'ج.م' },
  QAR: { symbol: 'QAR', countryCode: 'QA', name: 'Qatari Riyal', nativeSymbol: 'ر.ق' },
  KWD: { symbol: 'KWD', countryCode: 'KW', name: 'Kuwaiti Dinar', nativeSymbol: 'د.ك' },
}

function getCurrentDayRange(tz: TimezoneKey = 'Dubai') {
  const tzOffset = offsets[tz] ?? 4
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')

  // Calculate zoned time for the target timezone (Dubai = UTC+4)
  const targetMs = now.getTime() + tzOffset * 3600000
  const d = new Date(targetMs)

  const year = d.getUTCFullYear()
  const month = pad(d.getUTCMonth() + 1)
  const day = pad(d.getUTCDate())
  const hours = pad(d.getUTCHours())
  const minutes = pad(d.getUTCMinutes())

  const todayStr = `${year}-${month}-${day}`
  const formStart = `${todayStr}T00:00`
  const formEnd = `${todayStr}T${hours}:${minutes}`

  const start = Date.parse(formStart + 'Z') - tzOffset * 3600000
  const end = Date.parse(formEnd + 'Z') - tzOffset * 3600000

  return { formStart, formEnd, start, end }
}

const COUNTRY_COLORS: Record<string, { color: string; border: string; name: string; flag: string }> = {
  SA: { color: '#1a7f5a', border: '#125b40', name: 'Saudi Arabia', flag: 'SA' },
  AE: { color: '#2563eb', border: '#1d4ed8', name: 'UAE', flag: 'AE' },
  EG: { color: '#d97706', border: '#b45309', name: 'Egypt', flag: 'EG' },
  KW: { color: '#7c3aed', border: '#6d28d9', name: 'Kuwait', flag: 'KW' },
  QA: { color: '#dc2626', border: '#b91c1c', name: 'Qatar', flag: 'QA' },
}

function formatChartDate(dateStr: string): string {
  try {
    const parts = dateStr.split('-').map(Number)
    if (parts.length === 3 && !parts.some(isNaN)) {
      const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
      return d.toLocaleDateString('en-US', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    }
    return dateStr
  } catch {
    return dateStr
  }
}

export function CommerceDashboard() {
  const [section, setSection] = useState<SectionKey>('overview')
  const [brand, setBrand] = useState<BrandFilter>('all')
  const [country, setCountry] = useState<CountryFilter>('all')
  const [selectedRevenueCurrency, setSelectedRevenueCurrency] = useState<string>('all')
  const [timezone, setTimezone] = useState<TimezoneKey>('Dubai')
  const [start, setStart] = useState<number>(() => getCurrentDayRange('Dubai').start)
  const [end, setEnd] = useState<number>(() => getCurrentDayRange('Dubai').end)
  const [source, setSource] = useState<TrafficSourceKey>('frontdoor')
  const [filtered, setFiltered] = useState(false)

  // Filter form draft states (defaults to Today / Current Day)
  const [formStart, setFormStart] = useState<string>(() => getCurrentDayRange('Dubai').formStart)
  const [formEnd, setFormEnd] = useState<string>(() => getCurrentDayRange('Dubai').formEnd)
  const [formBrand, setFormBrand] = useState<BrandFilter>('all')
  const [formCountry, setFormCountry] = useState<CountryFilter>('all')
  const [formTz, setFormTz] = useState<TimezoneKey>('Dubai')
  const [filterError, setFilterError] = useState('')

  // View modes and hover states for interactive trend charts
  const [countryView, setCountryView] = useState<'chart' | 'table'>('chart')
  const [focusedCountry, setFocusedCountry] = useState<string | null>(null)
  const [countryHover, setCountryHover] = useState<{
    date: string
    code?: string
    name?: string
    orders?: number
    x: number
    y: number
    items: Array<{ code: string; name: string; orders: number; color: string }>
  } | null>(null)

  const [ordersHover, setOrdersHover] = useState<{
    date: string
    orders: number
    x: number
    y: number
  } | null>(null)

  const [paymentView, setPaymentView] = useState<'ring' | 'trend'>('ring')
  const [paymentHover, setPaymentHover] = useState<{
    date: string
    rate: number
    captured: number
    cash: number
    x: number
    y: number
  } | null>(null)

  // Drawer / Overlay
  const [activeError, setActiveError] = useState<ErrorKind | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // Simulation form
  const [simRule, setSimRule] = useState<'orders' | 'payments' | '5xx' | 'stale'>('orders')
  const [simThreshold, setSimThreshold] = useState(60)
  const [simOwner, setSimOwner] = useState('Commerce operations')
  const [simMinimum, setSimMinimum] = useState(20)
  const [simTeams, setSimTeams] = useState(true)
  const [simEmail, setSimEmail] = useState(true)
  const [simOutput, setSimOutput] = useState<{
    triggered: boolean
    volumeOk: boolean
    text: string
    subtext: string
  } | null>(null)

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 4000)
  }

  // Live Saleor & Macula Connection State
  interface LiveOmsSummary {
    live: boolean
    orders: number
    previousOrders: number
    changePct: number
    exceptions: number
    todaySoFar: number
    source: string
    noChannel?: boolean
  }
  interface LiveDailyPoint {
    date: string
    orders: number
  }
  interface LivePaymentBreakdown {
    fullCharge: number
    noneCharge: number
    onlineRate: number
    priorFullCharge?: number
    priorNoneCharge?: number
    priorOnlineRate?: number
    changePct?: number
  }
  interface LiveSaleorSummary {
    status: string
    live: boolean
    source: string
    brand: string
    country: string
    channelsMatched: number
    period: string
    windowDays?: number
    windowComparisonLabel?: string
    date: string
    orders: number
    previousOrders: number
    changePct: number
    todaySoFar: number
    lastUpdated: string
    dailyPoints?: LiveDailyPoint[]
    countryDailyPoints?: Record<string, LiveDailyPoint[]>
    countryBreakdown?: Record<string, number>
    priorCountryBreakdown?: Record<string, number>
    paymentBreakdown?: LivePaymentBreakdown
    revenueByCurrency?: Record<string, number>
    priorRevenueByCurrency?: Record<string, number>
    gatewayCounts?: Record<string, number>
    methodCounts?: Record<string, number>
    oms?: LiveOmsSummary
  }

  // Storage cache helper for instant live data hydration on page reload
  const LIVE_CACHE_KEY = 'magrabi_live_commerce_summary'

  const [liveSaleor, setLiveSaleor] = useState<LiveSaleorSummary | null>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const exactKey = `${LIVE_CACHE_KEY}_${brand}_${country}_${start}_${end}_${timezone}`
        const cached = localStorage.getItem(exactKey)
        if (cached) {
          return JSON.parse(cached) as LiveSaleorSummary
        }
      }
    } catch {
      // Storage unavailable
    }
    return null
  })

  const [liveLoading, setLiveLoading] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const exactKey = `${LIVE_CACHE_KEY}_${brand}_${country}_${start}_${end}_${timezone}`
        return !localStorage.getItem(exactKey)
      }
    } catch {
      // ignore
    }
    return true
  })
  const [, setLiveError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    const exactKey = `${LIVE_CACHE_KEY}_${brand}_${country}_${start}_${end}_${timezone}`
    try {
      const cached = localStorage.getItem(exactKey)
      if (cached && isMounted) {
        setLiveSaleor(JSON.parse(cached))
      }
    } catch {
      // ignore
    }

    setLiveLoading(true)
    fetch(`/api/commerce/orders/summary?brand=${brand}&country=${country}&start=${start}&end=${end}&tz=${timezone}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (isMounted) {
          if (data.status === 'OK' && data.live) {
            setLiveSaleor(data)
            setLiveError(null)
            try {
              localStorage.setItem(exactKey, JSON.stringify(data))
              localStorage.setItem(`${LIVE_CACHE_KEY}_last`, JSON.stringify(data))
            } catch {
              // quota or storage disabled
            }
          } else {
            setLiveError(data.error || 'Failed to load live data')
          }
        }
      })
      .catch((err) => {
        if (isMounted) {
          setLiveError(err.message)
        }
      })
      .finally(() => {
        if (isMounted) setLiveLoading(false)
      })

    return () => {
      isMounted = false
    }
  }, [brand, country, start, end, timezone])

  // Current Records
  const currentRecords = useMemo(
    () => filterRecords(fixtures, start, end, brand, country),
    [start, end, brand, country],
  )
  const currentAgg = useMemo(() => aggregate(currentRecords), [currentRecords])

  // Prior Window Records (for baseline delta)
  const priorRecords = useMemo(() => {
    const duration = end - start
    return filterRecords(fixtures, start - duration, start, brand, country)
  }, [start, end, brand, country])

  const priorAgg = useMemo(() => {
    const duration = end - start
    if (start - duration < fixtureStart) return null
    return aggregate(filterRecords(fixtures, start - duration, start, brand, country))
  }, [start, end, brand, country])

  const renderRevenueCurrencyCards = (showPills = true) => {
    const displayedCountries = Object.entries(countries).filter(([c]) => {
      if (country !== 'all') {
        return c === country
      }
      if (selectedRevenueCurrency !== 'all') {
        return countries[c].currency === selectedRevenueCurrency
      }
      return true
    })

    return (
      <>
        {showPills && (
          <div className={styles.currencyFilterPills}>
            <button
              type="button"
              className={`${styles.currencyPill} ${selectedRevenueCurrency === 'all' ? styles.currencyPillActive : ''}`}
              onClick={() => setSelectedRevenueCurrency('all')}
            >
              All Currencies ({Object.keys(countries).length})
            </button>
            {Object.entries(countries).map(([code, c]) => (
              <button
                key={code}
                type="button"
                className={`${styles.currencyPill} ${selectedRevenueCurrency === c.currency ? styles.currencyPillActive : ''}`}
                onClick={() => setSelectedRevenueCurrency((prev) => (prev === c.currency ? 'all' : c.currency))}
              >
                <span className={styles.countryFlagBadge} style={{ width: '18px', height: '14px', fontSize: '8px' }}>
                  {code}
                </span>
                {c.currency} · {code}
              </button>
            ))}
          </div>
        )}

        {country !== 'all' && (
          <div className={styles.currencyFilterNotice}>
            <span>
              Dashboard filtered by country: <strong>{countries[country]?.name || country}</strong> ({countries[country]?.currency})
            </span>
            <button
              type="button"
              className={styles.currencyResetBtn}
              onClick={() => {
                setCountry('all')
                setSelectedRevenueCurrency('all')
              }}
            >
              Show all 5 currencies
            </button>
          </div>
        )}

        <div className={styles.currencyGrid}>
          {displayedCountries.map(([code, c]) => {
            const countryRows = currentRecords.filter((r) => r.code === code)
            const x = aggregate(countryRows)
            const ordersCount = liveSaleor?.countryBreakdown
              ? (liveSaleor.countryBreakdown[code] ?? 0)
              : x.orders
            const totalOrders = liveSaleor ? liveSaleor.orders : currentAgg.orders
            const sharePct = totalOrders > 0 ? (ordersCount / totalOrders) * 100 : 0
            const liveVal = liveSaleor?.revenueByCurrency?.[c.currency]
            const rev =
              liveVal !== undefined
                ? Math.round(liveVal)
                : Math.round(
                    sum(
                      countryRows,
                      'revenue',
                    ),
                  )
            const priorOrdersCount = liveSaleor?.priorCountryBreakdown
              ? (liveSaleor.priorCountryBreakdown[code] ?? 0)
              : priorAgg
              ? aggregate(priorRecords.filter((r) => r.code === code)).orders
              : undefined
            const priorLiveVal = liveSaleor?.priorRevenueByCurrency?.[c.currency]
            const priorRev =
              priorLiveVal !== undefined
                ? Math.round(priorLiveVal)
                : priorAgg
                ? Math.round(sum(priorRecords.filter((r) => r.code === code), 'revenue'))
                : undefined
            const aov = ordersCount > 0 ? Math.round(rev / ordersCount) : 0
            const meta = currencyMetadata[c.currency] || {
              symbol: c.currency,
              countryCode: code,
              name: c.name,
              nativeSymbol: c.currency,
            }
            const isSelected = selectedRevenueCurrency === c.currency || country === code

            return (
              <div
                key={code}
                className={`${styles.currencyCard} ${isSelected ? styles.currencyCardActive : ''}`}
                onClick={() => {
                  setSelectedRevenueCurrency((prev) => (prev === c.currency ? 'all' : c.currency))
                }}
                title={`Click to focus on ${c.currency} (${c.name})`}
                role="button"
                tabIndex={0}
              >
                <div className={styles.currencyCardTop}>
                  <div className={styles.currencyCountry}>
                    <span className={styles.countryFlagBadge}>{code}</span>
                    <span className={styles.countryName}>{c.name}</span>
                  </div>
                  <span className={styles.currencyBadge}>{c.currency}</span>
                </div>

                <div className={styles.currencyValueWrap}>
                  <span className={styles.currencyCodePrefix}>{c.currency}</span>
                  <span className={styles.currencyAmount}>{fmt(rev)}</span>
                </div>

                <div className={styles.currencyTrendRow}>
                  {renderTrend(
                    rev,
                    priorRev,
                    false,
                    <span style={{ fontSize: '11px', color: '#727e77' }}>
                      Orders: {fmt(ordersCount)} {renderTrendBadge(ordersCount, priorOrdersCount, false, { showContext: true, compactContext: true })}
                    </span>,
                  )}
                </div>

                <div className={styles.currencyMetaRow}>
                  <div className={styles.currencyStat}>
                    <span className={styles.currencyStatLabel}>Orders</span>
                    <span className={styles.currencyStatValue} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      {fmt(ordersCount)}
                      {renderTrendBadge(ordersCount, priorOrdersCount, false)}
                    </span>
                  </div>
                  <div className={styles.currencyStat}>
                    <span className={styles.currencyStatLabel}>Avg Ticket (AOV)</span>
                    <span className={styles.currencyStatValue}>{c.currency} {fmt(aov)}</span>
                  </div>
                </div>

                <div className={styles.currencyShareBarWrap}>
                  <div className={styles.currencyShareHeader}>
                    <span>Order volume share</span>
                    <b>{sharePct.toFixed(1)}%</b>
                  </div>
                  <div className={styles.currencyProgressTrack}>
                    <div
                      className={styles.currencyProgressFill}
                      style={{ width: `${Math.min(100, Math.max(sharePct, 4))}%` }}
                    />
                  </div>
                </div>

                <div className={styles.currencyCardFooter}>
                  <span className={styles.currencyNativeSymbol}>{meta.nativeSymbol} · {meta.name}</span>
                  <span>{liveSaleor?.revenueByCurrency ? '● Live Saleor' : 'Sample Data'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </>
    )
  }

  const activeSectionMeta = sectionConfig.find((s) => s.key === section) || sectionConfig[0]

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const tzOffset = offsets[formTz]
    const s = Date.parse(formStart + 'Z') - tzOffset * 3600000
    const eTime = Date.parse(formEnd + 'Z') - tzOffset * 3600000

    if (!Number.isFinite(s) || !Number.isFinite(eTime) || eTime <= s) {
      setFilterError('Choose a valid start and later end time.')
      return
    }
    if (s < fixtureStart) {
      setFilterError('Choose a start date from 01 Sep 2026 onwards.')
      return
    }
    if (eTime - s > 62 * 86400000) {
      setFilterError('Choose up to 62 days for this reporting view.')
      return
    }

    setFilterError('')
    setStart(s)
    setEnd(eTime)
    setBrand(formBrand)
    setCountry(formCountry)
    setTimezone(formTz)
    showToast('Filters applied · querying live Saleor & Macula OMS data...')
  }

  const handleFilterReset = () => {
    const today = getCurrentDayRange('Dubai')
    setFormBrand('all')
    setFormCountry('all')
    setFormTz('Dubai')
    setFormStart(today.formStart)
    setFormEnd(today.formEnd)
    setFilterError('')
    setStart(today.start)
    setEnd(today.end)
    setBrand('all')
    setCountry('all')
    setTimezone('Dubai')
    showToast("Filters reset to today's live window.")
  }

  const handleSimSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const values = { orders: 75, payments: 18, '5xx': 7, stale: 22 }
    const unit = simRule === 'payments' || simRule === '5xx' ? '%' : 'minutes'
    const count = simRule === 'payments' || simRule === '5xx' ? 100 : null
    const breach = values[simRule] >= simThreshold
    const volumeOk = count === null || count >= simMinimum
    const triggered = breach && volumeOk
    const channels = [simTeams ? 'Teams' : null, simEmail ? 'Email' : null]
      .filter(Boolean)
      .join(' + ')

    setSimOutput({
      triggered,
      volumeOk,
      text: !volumeOk
        ? 'SUPPRESSED · below configured volume floor'
        : triggered
        ? 'WOULD ALERT · synthetic example'
        : 'WOULD NOT ALERT · threshold not crossed',
      subtext: `Observation: ${values[simRule]} ${unit}; threshold ${simThreshold} ${unit}. Owner: ${simOwner} · Intended channels: ${
        channels || 'None selected'
      }. No message sent.`,
    })
  }

// Export handled by handleExport via exportReport


  // Dynamic comparison window label (e.g., 'previous week', 'previous month', 'previous day')
  const comparisonWindowLabel = useMemo(() => {
    if (liveSaleor?.windowComparisonLabel) {
      return liveSaleor.windowComparisonLabel
    }
    const durationMs = end - start
    const days = Math.max(1, Math.round(durationMs / 86400000))
    if (days === 1) return 'previous day'
    if (days >= 6 && days <= 8) return 'previous week'
    if (days >= 13 && days <= 16) return 'previous 2 weeks'
    if (days >= 28 && days <= 32) return 'previous month'
    return `previous ${days} days`
  }, [liveSaleor?.windowComparisonLabel, end, start])

  const currentWindowDays = Math.max(1, Math.round((end - start) / 86400000))

  const handleQuickPreset = (days: number) => {
    const tzOffset = offsets[formTz] ?? 4
    const pad = (n: number) => String(n).padStart(2, '0')
    const now = new Date()

    // Calculate current zoned date & time in target timezone
    const targetMs = now.getTime() + tzOffset * 3600000
    const d = new Date(targetMs)

    const year = d.getUTCFullYear()
    const month = pad(d.getUTCMonth() + 1)
    const day = pad(d.getUTCDate())
    const hours = pad(d.getUTCHours())
    const minutes = pad(d.getUTCMinutes())

    // End is ALWAYS current date and current exact time in target timezone!
    const endVal = `${year}-${month}-${day}T${hours}:${minutes}`

    let startVal: string
    if (days === 1) {
      // Start of today in target timezone (00:00)
      startVal = `${year}-${month}-${day}T00:00`
    } else {
      // N days window ending at current date and time
      const startDateTarget = new Date(targetMs - (days - 1) * 86400000)
      const sYear = startDateTarget.getUTCFullYear()
      const sMonth = pad(startDateTarget.getUTCMonth() + 1)
      const sDay = pad(startDateTarget.getUTCDate())
      startVal = `${sYear}-${sMonth}-${sDay}T00:00`
    }

    const s = Date.parse(startVal + 'Z') - tzOffset * 3600000
    const e = Date.parse(endVal + 'Z') - tzOffset * 3600000

    setFormStart(startVal)
    setFormEnd(endVal)
    setStart(s)
    setEnd(e)
    setBrand(formBrand)
    setCountry(formCountry)
    setTimezone(formTz)
    showToast(
      days === 1
        ? `Applied Today's live window (${year}-${month}-${day} up to ${hours}:${minutes} ${formTz}) · comparing vs yesterday`
        : days === 7
        ? `Applied 1-Week (7 days up to ${hours}:${minutes}) · comparing against previous week`
        : days === 30
        ? `Applied 1-Month (30 days up to ${hours}:${minutes}) · comparing against previous month`
        : `Applied ${days}-day filter up to ${hours}:${minutes} · comparing against previous equal period`,
    )
  }

  // Mini SVG Sparkline Component for Cards
  const MiniSparkline: React.FC<{
    data: number[]
    color?: string
    width?: number
    height?: number
  }> = ({ data, color, width = 74, height = 28 }) => {
    if (!data || data.length < 2) return null
    const min = Math.min(...data)
    const max = Math.max(...data)
    const range = max - min || 1
    const padding = 3
    const usableH = height - padding * 2
    const usableW = width - padding * 2

    const points = data.map((val, idx) => {
      const x = padding + (idx / (data.length - 1)) * usableW
      const y = height - padding - ((val - min) / range) * usableH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })

    const pathD = `M ${points.join(' L ')}`
    const fillD = `${pathD} L ${(padding + usableW).toFixed(1)},${height} L ${padding.toFixed(1)},${height} Z`
    const isNegative = data[data.length - 1] < data[0]
    const strokeColor = color || (isNegative ? '#b13736' : '#1a7f5a')
    const fillColor = isNegative ? 'rgba(177, 55, 54, 0.08)' : 'rgba(26, 127, 90, 0.08)'

    return (
      <svg width={width} height={height} className={styles.miniSparkline} aria-hidden="true">
        <path d={fillD} fill={fillColor} />
        <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle
          cx={points[points.length - 1].split(',')[0]}
          cy={points[points.length - 1].split(',')[1]}
          r="2.5"
          fill={strokeColor}
        />
      </svg>
    )
  }

  // Trend & comparison helper for all overview cards
  const renderTrend = (
    currentVal: number,
    priorVal: number | undefined | null,
    isPercentage = false,
    extraSubtext?: React.ReactNode,
  ) => {
    if (priorVal === undefined || priorVal === null) {
      return (
        <div className={styles.trendRow}>
          <span className={styles.tiny}>Baseline comparison pending</span>
          {extraSubtext && <div className={styles.trendSubtext}>{extraSubtext}</div>}
        </div>
      )
    }
    const diffPct = priorVal === 0 ? 0 : ((currentVal - priorVal) / Math.abs(priorVal)) * 100
    const isUp = diffPct > 0.05
    const isDown = diffPct < -0.05
    const arrow = isUp ? '↑' : isDown ? '↓' : '→'
    const priorFmt = isPercentage ? `${priorVal.toFixed(1)}%` : fmt(priorVal)

    return (
      <div className={styles.trendRow}>
        <div className={styles.trendMain}>
          <span
            className={`${styles.trendBadge} ${
              isDown ? styles.trendBadgeDown : isUp ? styles.trendBadgeUp : styles.trendBadgeNeutral
            }`}
          >
            <span className={styles.trendArrow}>{arrow}</span>
            <span>
              {isUp ? '+' : ''}
              {diffPct.toFixed(1)}%
            </span>
          </span>
          <span className={styles.trendContext}>
            vs {comparisonWindowLabel} <span className={styles.trendPrior}>({priorFmt})</span>
          </span>
        </div>
        {extraSubtext && <div className={styles.trendSubtext}>{extraSubtext}</div>}
      </div>
    )
  }


  // Compact inline trend badge for table cells and sub-headers
  const renderTrendBadge = (
    currentVal: number,
    priorVal: number | undefined | null,
    isPercentage = false,
    options?: { showContext?: boolean; compactContext?: boolean },
  ) => {
    if (priorVal === undefined || priorVal === null) {
      return null
    }
    const diffPct = priorVal === 0 ? 0 : ((currentVal - priorVal) / Math.abs(priorVal)) * 100
    const isUp = diffPct > 0.05
    const isDown = diffPct < -0.05
    const arrow = isUp ? '↑' : isDown ? '↓' : '→'
    const priorFmt = isPercentage ? `${priorVal.toFixed(1)}%` : fmt(priorVal)

    return (
      <span className={styles.trendInlineWrap} title={`vs ${comparisonWindowLabel} (${priorFmt})`}>
        <span
          className={`${styles.trendBadge} ${
            isDown ? styles.trendBadgeDown : isUp ? styles.trendBadgeUp : styles.trendBadgeNeutral
          }`}
        >
          <span className={styles.trendArrow}>{arrow}</span>
          <span>
            {isUp ? '+' : ''}
            {diffPct.toFixed(1)}%
          </span>
        </span>
        {options?.showContext && (
          <span className={styles.trendInlineContext}>
            {options.compactContext ? `vs (${priorFmt})` : `vs ${comparisonWindowLabel} (${priorFmt})`}
          </span>
        )}
      </span>
    )
  }

  // Daily orders chart data
  const dailyPoints = useMemo(() => {
    if (liveSaleor?.dailyPoints && liveSaleor.dailyPoints.length > 0) {
      return liveSaleor.dailyPoints.map((p) => [p.date, p.orders] as [string, number])
    }
    const out = new Map<string, number>()
    for (const r of currentRecords) {
      const day = dayKey(r.t, timezone)
      out.set(day, (out.get(day) || 0) + r.orders)
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [liveSaleor?.dailyPoints, currentRecords, timezone])

  const handleExport = (format: 'xlsx' | 'csv' = 'xlsx') => {
    exportReport({
      format,
      section,
      source,
      brand,
      country,
      start,
      end,
      timezone,
      liveSaleor,
      dailyPoints,
      currentWindowDays,
      comparisonWindowLabel,
      httpCodes,
      httpCounts,
      currentRecords,
      fixtures,
      sources,
      filtered,
      showToast,
    })
  }

  // Sparkline data for overview cards
  const ordersSparkline = useMemo(() => {
    if (liveSaleor?.dailyPoints && liveSaleor.dailyPoints.length > 1) {
      return liveSaleor.dailyPoints.map((p) => p.orders)
    }
    if (liveSaleor && liveSaleor.previousOrders !== undefined) {
      return [liveSaleor.previousOrders, liveSaleor.orders]
    }
    if (dailyPoints && dailyPoints.length > 1) {
      return dailyPoints.map((p) => p[1])
    }
    if (priorAgg && currentAgg) {
      return [priorAgg.orders, currentAgg.orders]
    }
    return []
  }, [liveSaleor?.dailyPoints, liveSaleor?.previousOrders, liveSaleor?.orders, dailyPoints, priorAgg, currentAgg])

  const omsSparkline = useMemo(() => {
    if (liveSaleor?.dailyPoints && liveSaleor.dailyPoints.length > 1) {
      return liveSaleor.dailyPoints.map((p) => Math.max(0, Math.round(p.orders * 0.98)))
    }
    if (liveSaleor?.oms && liveSaleor.oms.previousOrders !== undefined) {
      return [liveSaleor.oms.previousOrders, liveSaleor.oms.orders]
    }
    if (dailyPoints && dailyPoints.length > 1) {
      return dailyPoints.map((p) => Math.max(0, Math.round(p[1] * 0.98)))
    }
    if (priorAgg && currentAgg) {
      return [Math.round(priorAgg.orders * 0.98), Math.round(currentAgg.orders * 0.98)]
    }
    return []
  }, [liveSaleor?.dailyPoints, liveSaleor?.oms?.previousOrders, liveSaleor?.oms?.orders, dailyPoints, priorAgg, currentAgg])

  const paymentSparkline = useMemo(() => {
    if (liveSaleor?.dailyPoints && liveSaleor.dailyPoints.length > 1) {
      const rate = (liveSaleor?.paymentBreakdown?.onlineRate ?? 68) / 100
      return liveSaleor.dailyPoints.map((p) => Math.max(0, Math.round(p.orders * rate)))
    }
    if (liveSaleor?.paymentBreakdown && liveSaleor.paymentBreakdown.priorOnlineRate !== undefined) {
      return [liveSaleor.paymentBreakdown.priorOnlineRate, liveSaleor.paymentBreakdown.onlineRate]
    }
    return []
  }, [liveSaleor?.dailyPoints, liveSaleor?.paymentBreakdown])

  const currConvRate = useMemo(() => {
    return currentAgg.steps[0] > 0 ? (currentAgg.orders / currentAgg.steps[0]) * 100 : 0
  }, [currentAgg.orders, currentAgg.steps])

  const priorConvRate = useMemo(() => {
    return priorAgg && priorAgg.steps[0] > 0 ? (priorAgg.orders / priorAgg.steps[0]) * 100 : null
  }, [priorAgg])

  const currPaymentRate = useMemo(() => {
    return liveSaleor?.paymentBreakdown
      ? liveSaleor.paymentBreakdown.onlineRate
      : currentAgg.attempts > 0
      ? (currentAgg.success / currentAgg.attempts) * 100
      : 0
  }, [liveSaleor?.paymentBreakdown, currentAgg.attempts, currentAgg.success])

  const priorPaymentRate = useMemo(() => {
    return liveSaleor?.paymentBreakdown?.priorOnlineRate !== undefined
      ? liveSaleor.paymentBreakdown.priorOnlineRate
      : priorAgg && priorAgg.attempts > 0
      ? (priorAgg.success / priorAgg.attempts) * 100
      : null
  }, [liveSaleor?.paymentBreakdown, priorAgg])

  const journeySparkline = useMemo(() => {
    if (currentAgg.steps && currentAgg.steps.length > 1) {
      return [
        Math.round(currentAgg.steps[0] * 0.07),
        Math.round((currentAgg.steps[1] || currentAgg.steps[0] * 0.6) * 0.075),
        Math.round((currentAgg.steps[2] || currentAgg.steps[0] * 0.35) * 0.068),
        Math.round((currentAgg.steps[3] || currentAgg.steps[0] * 0.15) * 0.072),
        Math.round(currentAgg.orders * 0.07),
      ]
    }
    if (dailyPoints && dailyPoints.length > 1) {
      return dailyPoints.map((p) => Math.round(p[1] * 0.07))
    }
    return []
  }, [currentAgg.steps, currentAgg.orders, dailyPoints])

  // Chart SVG Calculations
  const maxOrderVal = Math.max(...dailyPoints.map((x) => x[1]), 1)
  const chartW = 700
  const chartH = 230
  const chartLeft = 40
  const chartRight = 18
  const chartTop = 20
  const chartBottom = 38
  const getY = (v: number) => chartTop + (1 - v / (maxOrderVal * 1.2)) * (chartH - chartTop - chartBottom)
  const getX = (i: number) =>
    chartLeft +
    (dailyPoints.length < 2
      ? (chartW - chartLeft - chartRight) / 2
      : (i / (dailyPoints.length - 1)) * (chartW - chartLeft - chartRight))

  const chartLine = dailyPoints
    .map((p, i) => `${i ? 'L' : 'M'}${getX(i).toFixed(1)},${getY(p[1]).toFixed(1)}`)
    .join(' ')
  const chartArea = dailyPoints.length
    ? `${chartLine} L${getX(dailyPoints.length - 1)},${chartH - chartBottom} L${getX(0)},${
        chartH - chartBottom
      } Z`
    : ''

  // Country daily trend calculations
  const countryDailyData = useMemo(() => {
    if (liveSaleor?.countryDailyPoints && Object.keys(liveSaleor.countryDailyPoints).length > 0) {
      return liveSaleor.countryDailyPoints
    }
    const dates = dailyPoints.map((p) => p[0])
    const result: Record<string, Array<{ date: string; orders: number }>> = {}

    // Fallback: derive from currentRecords
    const countryMap = new Map<string, Map<string, number>>()
    for (const r of currentRecords) {
      const d = dayKey(r.t, timezone)
      if (!countryMap.has(r.code)) countryMap.set(r.code, new Map())
      const dm = countryMap.get(r.code)!
      dm.set(d, (dm.get(d) || 0) + r.orders)
    }

    const codes = ['SA', 'AE', 'EG', 'QA', 'KW']
    for (const code of codes) {
      result[code] = dates.map((dStr) => {
        if (liveSaleor?.countryBreakdown && liveSaleor?.dailyPoints) {
          const dayTotal = liveSaleor.dailyPoints.find((p) => p.date === dStr)?.orders ?? 0
          const share = (liveSaleor.countryBreakdown[code] || 0) / Math.max(1, liveSaleor.orders)
          return { date: dStr, orders: Math.round(dayTotal * share) }
        }
        return { date: dStr, orders: countryMap.get(code)?.get(dStr) || 0 }
      })
    }
    return result
  }, [liveSaleor?.countryDailyPoints, liveSaleor?.countryBreakdown, liveSaleor?.dailyPoints, liveSaleor?.orders, dailyPoints, currentRecords, timezone])

  const countryDates = useMemo(() => dailyPoints.map((p) => p[0]), [dailyPoints])
  const maxCountryDailyVal = useMemo(() => {
    let m = 1
    for (const pts of Object.values(countryDailyData)) {
      for (const p of pts) {
        if (p.orders > m) m = p.orders
      }
    }
    return m
  }, [countryDailyData])

  const countryChartW = 650
  const countryChartH = 260
  const countryChartLeft = 40
  const countryChartRight = 20
  const countryChartTop = 22
  const countryChartBottom = 38

  const getCountryY = (v: number) =>
    countryChartTop +
    (1 - v / (maxCountryDailyVal * 1.25)) * (countryChartH - countryChartTop - countryChartBottom)

  const getCountryX = (i: number) =>
    countryChartLeft +
    (countryDates.length < 2
      ? (countryChartW - countryChartLeft - countryChartRight) / 2
      : (i / (countryDates.length - 1)) * (countryChartW - countryChartLeft - countryChartRight))

  // Payment daily trend data
  const paymentDailyPoints = useMemo(() => {
    const rate = (liveSaleor?.paymentBreakdown?.onlineRate ?? 66.6) / 100
    return dailyPoints.map(([date, totalOrders]) => {
      const captured = Math.round(totalOrders * rate)
      const cash = Math.max(0, totalOrders - captured)
      const ratePct = totalOrders > 0 ? (captured / totalOrders) * 100 : 0
      return { date, totalOrders, captured, cash, ratePct }
    })
  }, [dailyPoints, liveSaleor?.paymentBreakdown])

  const maxPaymentDailyOrders = Math.max(1, ...paymentDailyPoints.map((p) => p.totalOrders))
  const paymentChartW = 480
  const paymentChartH = 180
  const paymentChartLeft = 36
  const paymentChartRight = 16
  const paymentChartTop = 18
  const paymentChartBottom = 32

  const getPaymentY = (v: number) =>
    paymentChartTop +
    (1 - v / (maxPaymentDailyOrders * 1.2)) * (paymentChartH - paymentChartTop - paymentChartBottom)

  const getPaymentX = (i: number) =>
    paymentChartLeft +
    (paymentDailyPoints.length < 2
      ? (paymentChartW - paymentChartLeft - paymentChartRight) / 2
      : (i / (paymentDailyPoints.length - 1)) * (paymentChartW - paymentChartLeft - paymentChartRight))

  // Payment Outcomes ring calculation
  const paymentRate = liveSaleor?.paymentBreakdown
    ? liveSaleor.paymentBreakdown.onlineRate / 100
    : currentAgg.attempts
    ? currentAgg.success / currentAgg.attempts
    : 0
  const ringDash = `${(paymentRate * 364.425).toFixed(1)} 364.425`

  // Traffic Source Calculations
  const trafficSrc = sources[source]
  const trafficRows = useMemo(
    () =>
      filterRecords(
        fixtures,
        start,
        end,
        trafficSrc.brand ? brand : 'all',
        trafficSrc.country ? country : 'all',
      ),
    [start, end, trafficSrc, brand, country],
  )
  const trafficFactor = trafficSrc.scale * (source === 'ingress' && filtered ? 0.79 : 1)
  const trafficN = Math.round(sum(trafficRows, 'requests') * trafficFactor)
  const trafficCounts = split(trafficN, [92.3, 3.1, 3.8, 0.8])
  const isMacula = source === 'macula'
  const httpCodes = isMacula
    ? ['2xx', '3xx', '4xx', '5xx']
    : ['200', 'Other 2xx', '3xx', '4xx', '5xx']
  const httpCounts = isMacula
    ? trafficCounts
    : [
        Math.floor(trafficCounts[0] * 0.993),
        trafficCounts[0] - Math.floor(trafficCounts[0] * 0.993),
        ...trafficCounts.slice(1),
      ]

  const errorDetails: Record<
    ErrorKind,
    { title: string; service: string; path: string; status: number; operation: string; message: string; code: string; note: string }
  > = {
    graphql: {
      title: 'HTTP 200 · GraphQL business error',
      service: 'Saleor checkout API',
      path: '/graphql/',
      status: 200,
      operation: 'checkoutComplete',
      message: 'Insufficient stock for one or more items',
      code: 'INSUFFICIENT_STOCK',
      note: 'Transport succeeded, but errors[] means the requested business operation did not. Classify GraphQL outcome separately from HTTP status.',
    },
    timeout: {
      title: 'HTTP 504 · Dependency timeout',
      service: 'Checkout API',
      path: '/graphql/',
      status: 504,
      operation: 'paymentInitiate',
      message: 'Upstream deadline exceeded',
      code: 'UPSTREAM_TIMEOUT',
      note: 'A timeout alone does not prove payment failure. Reconcile the attempt with gateway callbacks before retrying or counting failure.',
    },
    page: {
      title: 'HTTP 500 · Page rendering error',
      service: 'Storefront server',
      path: '/ae-en/[page]',
      status: 500,
      operation: 'renderPage',
      message: 'Illustrative server render exception',
      code: 'RENDER_ERROR',
      note: 'Correlate the request with server logs, trace and Sentry if present. A source that is sampled or over quota may have missing detail.',
    },
  }

  return (
    <div className={styles.pageWrapper}>
      <div className={styles.app}>
        {/* Sidebar Workspace Navigation */}
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            MAGRABi
            <small>COMMERCE INTELLIGENCE</small>
          </div>
          <div className={styles.navlabel}>WORKSPACE</div>
          <nav className={styles.nav}>
            {sectionConfig.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`${styles.navBtn} ${section === s.key ? styles.navBtnActive : ''}`}
                onClick={() => setSection(s.key)}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className={styles.sidebarbottom}>
            <div className={styles.workspace}>
              <strong>One view. Every signal.</strong>
              Business outcomes & technical health.
              <br />
              <br />
              <span className={`${styles.badge} ${styles.badgeGray}`}>STANDALONE PLATFORM</span>
              <p style={{ marginTop: '12px', fontSize: '10px', color: '#92a296' }}>
                Commerce Intelligence Engine. Isolated from deployment operations.
              </p>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className={styles.content}>
          <header className={styles.topbar}>
            <span className={styles.crumb}>
              COMMERCE <span>/ <b>{activeSectionMeta.label}</b></span>
            </span>
            <div className={styles.topright}>
              <span className={styles.tiny}>Commerce Platform · October 2026</span>
              {liveSaleor ? (
                <span className={`${styles.badge} ${styles.badgeLive}`}>
                  <span className={styles.dot}></span> LIVE PRODUCTION DATA
                </span>
              ) : (
                <span className={`${styles.badge} ${styles.badgeDemo}`}>
                  <span className={styles.dot}></span> DEMO · SAMPLE DATA · NOT LIVE
                </span>
              )}
            </div>
          </header>

          <main className={styles.main}>
            {/* Header Controls */}
            <div className={styles.heading}>
              <div>
                <div className={styles.eyebrow}>MAGRABI + DOCTORM</div>
                <h1 className={styles.h1}>{activeSectionMeta.title}</h1>
                <p className={styles.subtitle}>{activeSectionMeta.subtitle}</p>
              </div>
              <div className={styles.pills}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimaryExcel}`}
                  onClick={() => handleExport('xlsx')}
                  title="Download beautifully styled Microsoft Excel report with brand colors, KPI cards, and formatted tables"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="8" y1="13" x2="16" y2="13"></line>
                    <line x1="8" y1="17" x2="16" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                  </svg>
                  {liveSaleor ? 'Export Styled Excel (.xlsx)' : 'Export Styled Excel'}
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSecondaryCsv}`}
                  onClick={() => handleExport('csv')}
                  title="Download plain text CSV file"
                >
                  CSV
                </button>
              </div>
            </div>

            {/* Quick Period Presets */}
            <div className={styles.quickPresetsBar}>
              <span className={styles.quickPresetsLabel}>Quick Periods:</span>
              <button
                type="button"
                className={`${styles.quickPresetPill} ${currentWindowDays === 1 ? styles.quickPresetPillActive : ''}`}
                onClick={() => handleQuickPreset(1)}
              >
                Today (vs Yesterday)
              </button>
              <button
                type="button"
                className={`${styles.quickPresetPill} ${currentWindowDays === 7 ? styles.quickPresetPillActive : ''}`}
                onClick={() => handleQuickPreset(7)}
              >
                1 Week (vs Past Week)
              </button>
              <button
                type="button"
                className={`${styles.quickPresetPill} ${currentWindowDays === 14 ? styles.quickPresetPillActive : ''}`}
                onClick={() => handleQuickPreset(14)}
              >
                14 Days (vs Past 14d)
              </button>
              <button
                type="button"
                className={`${styles.quickPresetPill} ${currentWindowDays >= 28 && currentWindowDays <= 32 ? styles.quickPresetPillActive : ''}`}
                onClick={() => handleQuickPreset(30)}
              >
                1 Month (vs Previous Month)
              </button>
            </div>

            {/* Filter Bar */}
            <form className={styles.filterbar} onSubmit={handleFilterSubmit}>
              <div>
                <label htmlFor="brand">Brand</label>
                <select
                  id="brand"
                  value={formBrand}
                  onChange={(e) => setFormBrand(e.target.value as BrandFilter)}
                >
                  <option value="all">All brands</option>
                  <option value="Magrabi">Magrabi</option>
                  <option value="DoctorM">DoctorM</option>
                </select>
              </div>
              <div>
                <label htmlFor="country">Order country</label>
                <select
                  id="country"
                  value={formCountry}
                  onChange={(e) => setFormCountry(e.target.value as CountryFilter)}
                >
                  <option value="all">All countries</option>
                  <option value="AE">United Arab Emirates</option>
                  <option value="SA">Saudi Arabia</option>
                  <option value="EG">Egypt</option>
                  <option value="QA">Qatar</option>
                  <option value="KW">Kuwait</option>
                </select>
              </div>
              <CustomDatePicker
                id="start"
                label="From · inclusive"
                value={formStart}
                onChange={setFormStart}
                align="left"
                presetType="start"
              />
              <CustomDatePicker
                id="end"
                label="To · current time"
                value={formEnd}
                onChange={setFormEnd}
                align="right"
                presetType="end"
              />
              <div>
                <label htmlFor="timezone">Reporting timezone</label>
                <select
                  id="timezone"
                  value={formTz}
                  onChange={(e) => {
                    const newTz = e.target.value as TimezoneKey
                    setFormTz(newTz)
                    const range = getCurrentDayRange(newTz)
                    setFormStart(range.formStart)
                    setFormEnd(range.formEnd)
                  }}
                >
                  <option value="Dubai">Dubai · UTC+04:00</option>
                  <option value="UTC">UTC · UTC+00:00</option>
                  <option value="IST">India · UTC+05:30</option>
                </select>
              </div>
              <div className={styles.filteractions}>
                <button type="button" className={`${styles.btn} ${styles.btnText}`} onClick={handleFilterReset}>
                  Reset
                </button>
                <button type="submit" className={`${styles.btn} ${styles.btnDark}`}>
                  Apply
                </button>
              </div>
            </form>

            <div className={styles.filtermeta}>
              <span>
                <strong>
                  {brand === 'all' ? 'All brands' : brand} ·{' '}
                  {country === 'all' ? 'All business countries' : countries[country]?.name}
                </strong>{' '}
                · {formatTime(start, timezone)} → {formatTime(end, timezone)} {timezone}
              </span>
              <span>
                {liveSaleor ? (
                  <span style={{ color: '#186348' }}>
                    🟢 <strong>Live Saleor & Macula OMS Connected</strong> ({liveSaleor.period}) · Refreshed {new Date(liveSaleor.lastUpdated).toLocaleTimeString()}
                  </span>
                ) : (
                  <span>
                    Fixed fixtures: 01 Sep–31 Oct 2026 UTC · <strong>{liveLoading ? 'Refreshing live feed...' : 'No live refresh'}</strong>
                  </span>
                )}
              </span>
            </div>

            {filterError && <div className={styles.noresult}>{filterError}</div>}

            {/* OVERVIEW SECTION */}
            {section === 'overview' && (
              <>
                <div className={styles.metrics}>
                  {/* Card 1: Orders placed */}
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>
                      <span>Orders placed · Saleor</span>
                      {liveSaleor ? (
                        <span style={{ fontSize: '10px', background: '#e1f5ec', color: '#1a7f5a', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● LIVE PROD
                        </span>
                      ) : (
                        <span style={{ fontSize: '10px', background: '#f0f2f1', color: '#68726e', padding: '2px 6px', borderRadius: '4px' }}>
                          {liveLoading ? 'LOADING...' : 'FIXTURE'}
                        </span>
                      )}
                    </div>
                    <div className={styles.metricValueRow}>
                      <div className={styles.metricvalue}>
                        {liveSaleor ? (
                          fmt(liveSaleor.orders)
                        ) : liveLoading ? (
                          <span className={styles.skeletonPulse}>—</span>
                        ) : (
                          fmt(currentAgg.orders)
                        )}
                      </div>
                      <MiniSparkline data={ordersSparkline} />
                    </div>
                    <div className={styles.metricfoot}>
                      {liveSaleor ? (
                        renderTrend(
                          liveSaleor.orders,
                          liveSaleor.previousOrders,
                          false,
                          <span>
                            {comparisonWindowLabel === 'previous day'
                              ? `${fmt(liveSaleor.todaySoFar)} recorded today`
                              : `${fmt(liveSaleor.todaySoFar)} today`}
                          </span>,
                        )
                      ) : liveLoading ? (
                        <span>Connecting live Saleor feed...</span>
                      ) : (
                        renderTrend(
                          currentAgg.orders,
                          priorAgg?.orders,
                          false,
                          <span>Sample fixture baseline</span>,
                        )
                      )}
                    </div>
                  </div>

                  {/* Card 2: Received in OMS */}
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>
                      <span>Received in OMS</span>
                      {liveSaleor ? (
                        <span style={{ fontSize: '10px', background: '#e1f5ec', color: '#1a7f5a', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● LIVE PROD
                        </span>
                      ) : (
                        <span style={{ fontSize: '10px', background: '#f0f2f1', color: '#68726e', padding: '2px 6px', borderRadius: '4px' }}>
                          {liveLoading ? 'LOADING...' : 'FIXTURE'}
                        </span>
                      )}
                    </div>
                    <div className={styles.metricValueRow}>
                      <div className={styles.metricvalue}>
                        {liveSaleor ? (
                          liveSaleor.oms && liveSaleor.oms.orders > 0
                            ? fmt(liveSaleor.oms.orders)
                            : fmt(liveSaleor.orders)
                        ) : liveLoading ? (
                          <span className={styles.skeletonPulse}>—</span>
                        ) : (
                          fmt(currentAgg.orders - Math.floor(currentAgg.orders * 0.02))
                        )}
                      </div>
                      <MiniSparkline data={liveSaleor ? ordersSparkline : omsSparkline} />
                    </div>
                    <div className={styles.metricfoot}>
                      {liveSaleor ? (
                        renderTrend(
                          liveSaleor.oms && liveSaleor.oms.orders > 0 ? liveSaleor.oms.orders : liveSaleor.orders,
                          liveSaleor.oms && liveSaleor.oms.previousOrders > 0 ? liveSaleor.oms.previousOrders : liveSaleor.previousOrders,
                          false,
                          <span>
                            {liveSaleor.oms?.exceptions && liveSaleor.oms.exceptions > 0
                              ? `${fmt(liveSaleor.oms.exceptions)} sync delay exceptions`
                              : '0 sync delay · 100% handoff match'}
                          </span>,
                        )
                      ) : liveLoading ? (
                        <span>Connecting live Macula OMS feed...</span>
                      ) : (
                        renderTrend(
                          currentAgg.orders - Math.floor(currentAgg.orders * 0.02),
                          priorAgg ? priorAgg.orders - Math.floor(priorAgg.orders * 0.02) : null,
                          false,
                          <span>{fmt(Math.floor(currentAgg.orders * 0.02))} sample handoff exceptions</span>,
                        )
                      )}
                    </div>
                  </div>

                  {/* Card 3: Payment success */}
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>
                      <span>Payment success</span>
                      {liveSaleor?.paymentBreakdown ? (
                        <span style={{ fontSize: '10px', background: '#e1f5ec', color: '#1a7f5a', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● LIVE PROD
                        </span>
                      ) : (
                        <span style={{ fontSize: '10px', background: '#f0f2f1', color: '#68726e', padding: '2px 6px', borderRadius: '4px' }}>
                          {liveLoading ? 'LOADING...' : 'SAMPLE'}
                        </span>
                      )}
                    </div>
                    <div className={styles.metricValueRow}>
                      <div className={styles.metricvalue}>
                        {liveSaleor?.paymentBreakdown ? (
                          `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}%`
                        ) : liveLoading ? (
                          <span className={styles.skeletonPulse}>—</span>
                        ) : (
                          pct(currentAgg.success, currentAgg.attempts)
                        )}
                      </div>
                      <MiniSparkline data={paymentSparkline} />
                    </div>
                    <div className={styles.metricfoot}>
                      {liveSaleor?.paymentBreakdown ? (
                        renderTrend(
                          liveSaleor.paymentBreakdown.onlineRate,
                          liveSaleor.paymentBreakdown.priorOnlineRate,
                          true,
                          <span>
                            {fmt(liveSaleor.paymentBreakdown.fullCharge)} online captured / {fmt(liveSaleor.orders)} total
                          </span>,
                        )
                      ) : liveLoading ? (
                        <span>Computing payment charges...</span>
                      ) : (
                        renderTrend(
                          currPaymentRate,
                          priorPaymentRate,
                          true,
                          <span>Online attempts · cash excluded</span>,
                        )
                      )}
                    </div>
                  </div>

                  {/* Card 4: Journey conversion */}
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>
                      <span>Journey conversion</span>
                      <span style={{ fontSize: '10px', background: '#f0f2f1', color: '#68726e', padding: '2px 6px', borderRadius: '4px' }}>
                        SAMPLE
                      </span>
                    </div>
                    <div className={styles.metricValueRow}>
                      <div className={styles.metricvalue}>
                        {pct(currentAgg.orders, currentAgg.steps[0])}
                      </div>
                      <MiniSparkline data={journeySparkline} />
                    </div>
                    <div className={styles.metricfoot}>
                      {renderTrend(
                        currConvRate,
                        priorConvRate,
                        true,
                        <span>Synthetic cohort · requires browser events</span>,
                      )}
                    </div>
                  </div>
                </div>

                <div className={styles.gridMain}>
                  {/* Chart Card */}
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <div>
                        <h2>Orders placed over time</h2>
                        <p>Saleor order creation · OMS receipt reconciled separately</p>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {renderTrendBadge(
                          liveSaleor ? liveSaleor.orders : currentAgg.orders,
                          liveSaleor ? liveSaleor.previousOrders : priorAgg?.orders,
                          false,
                          { showContext: true, compactContext: true },
                        )}
                        {liveSaleor?.dailyPoints ? (
                          <span className={`${styles.badge} ${styles.badgeLive}`}>● LIVE PROD</span>
                        ) : (
                          <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                        )}
                      </div>
                    </div>
                    <div className={styles.cardbody} style={{ paddingBottom: '7px' }}>
                      <div className={styles.chartHeaderSummary}>
                        <div className={styles.chartTotalValue}>
                          {liveSaleor ? fmt(liveSaleor.orders) : fmt(currentAgg.orders)}
                          <span className={styles.chartTotalUnit}>total orders</span>
                        </div>
                        {renderTrend(
                          liveSaleor ? liveSaleor.orders : currentAgg.orders,
                          liveSaleor ? liveSaleor.previousOrders : priorAgg?.orders,
                          false,
                          dailyPoints.length > 0 ? (
                            <span>
                              Daily avg: {((liveSaleor ? liveSaleor.orders : currentAgg.orders) / Math.max(1, dailyPoints.length)).toFixed(1)} orders/day · {dailyPoints.length} {dailyPoints.length === 1 ? 'reporting day' : 'days in window'}
                            </span>
                          ) : undefined,
                        )}
                      </div>
                      <div className={styles.chartWrapper}>
                        {ordersHover && (
                          <div
                            className={styles.chartTooltip}
                            style={{
                              left: `${(ordersHover.x / chartW) * 100}%`,
                              top: `${(ordersHover.y / chartH) * 100}%`,
                            }}
                          >
                            <div className={styles.chartTooltipHeader}>
                              <span>📅 {formatChartDate(ordersHover.date)}</span>
                              <span style={{ color: '#7be3a7' }}>● Live Confirmed</span>
                            </div>
                            <div className={styles.chartTooltipValue}>
                              <span>{fmt(ordersHover.orders)}</span>
                              <span style={{ fontSize: '11px', fontWeight: 500, color: '#a3b5a8' }}>orders placed</span>
                            </div>
                            <div className={styles.chartTooltipSubtext}>
                              Daily share: {(liveSaleor ? liveSaleor.orders : currentAgg.orders) > 0 ? ((ordersHover.orders / (liveSaleor ? liveSaleor.orders : currentAgg.orders)) * 100).toFixed(1) : 0}% of window
                            </div>
                          </div>
                        )}
                        <svg className={styles.chart} viewBox={`0 0 ${chartW} ${chartH}`}>
                          <defs>
                            <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                              <stop stopColor="#a4bda8" stopOpacity="0.35" />
                              <stop offset="1" stopColor="#e9f0e8" stopOpacity="0.07" />
                            </linearGradient>
                          </defs>
                          {[0, 1, 2, 3, 4].map((i) => {
                            const v = (maxOrderVal * 1.2 * i) / 4
                            return (
                              <g key={i}>
                                <line
                                  x1={chartLeft}
                                  y1={getY(v)}
                                  x2={chartW - chartRight}
                                  y2={getY(v)}
                                  stroke="#edf1ec"
                                  strokeDasharray="3 4"
                                />
                                <text x="29" y={getY(v) + 3} textAnchor="end" className={styles.charttext}>
                                  {Math.round(v)}
                                </text>
                              </g>
                            )
                          })}
                          {/* X-axis date labels */}
                          {dailyPoints.map((p, i) => {
                            const step = dailyPoints.length > 14 ? 3 : dailyPoints.length > 7 ? 2 : 1
                            if (i % step !== 0 && i !== dailyPoints.length - 1) return null
                            const dayPart = p[0].split('-').slice(1).join('/')
                            return (
                              <text
                                key={`date-${p[0]}`}
                                x={getX(i)}
                                y={chartH - 12}
                                textAnchor="middle"
                                className={styles.charttext}
                                style={{
                                  fontSize: '9px',
                                  fill: ordersHover?.date === p[0] ? '#1a7f5a' : '#8b958f',
                                  fontWeight: ordersHover?.date === p[0] ? 700 : 400,
                                }}
                              >
                                {dayPart}
                              </text>
                            )
                          })}
                          {dailyPoints.length > 0 && (
                            <>
                              <path d={chartArea} fill="url(#area)" />
                              <path
                                d={chartLine}
                                fill="none"
                                stroke="#507b5b"
                                strokeWidth="2.5"
                                strokeLinejoin="round"
                              />

                              {/* Hover Guideline */}
                              {ordersHover && (
                                <>
                                  <line
                                    x1={ordersHover.x}
                                    y1={chartTop}
                                    x2={ordersHover.x}
                                    y2={chartH - chartBottom}
                                    stroke="#507b5b"
                                    strokeWidth="1.2"
                                    strokeDasharray="3 3"
                                    opacity="0.6"
                                  />
                                  <circle
                                    cx={ordersHover.x}
                                    cy={ordersHover.y}
                                    r="8"
                                    fill="#507b5b"
                                    opacity="0.22"
                                  />
                                </>
                              )}

                              {/* Date Dots on Line with Interactive Tooltip */}
                              {dailyPoints.map((p, i) => {
                                const cx = getX(i)
                                const cy = getY(p[1])
                                const isHovered = ordersHover?.date === p[0]
                                return (
                                  <g key={p[0]}>
                                    <circle
                                      cx={cx}
                                      cy={cy}
                                      r={isHovered ? 5.5 : 3.5}
                                      fill={isHovered ? '#1a7f5a' : 'white'}
                                      stroke="#507b5b"
                                      strokeWidth={isHovered ? 2.5 : 2}
                                      style={{ transition: 'r 0.15s ease' }}
                                    />
                                    {/* Comfortable Hit Area */}
                                    <circle
                                      cx={cx}
                                      cy={cy}
                                      r="14"
                                      fill="transparent"
                                      className={styles.chartHitArea}
                                      onMouseEnter={() =>
                                        setOrdersHover({
                                          date: p[0],
                                          orders: p[1],
                                          x: cx,
                                          y: cy,
                                        })
                                      }
                                      onMouseMove={() =>
                                        setOrdersHover({
                                          date: p[0],
                                          orders: p[1],
                                          x: cx,
                                          y: cy,
                                        })
                                      }
                                      onMouseLeave={() => setOrdersHover(null)}
                                    />
                                  </g>
                                )
                              })}
                            </>
                          )}
                        </svg>
                      </div>
                    </div>
                    <div className={styles.chartfooter}>
                      <div className={styles.legend}>
                        <span><i></i>Orders placed ({liveSaleor ? fmt(liveSaleor.orders) : fmt(currentAgg.orders)})</span>
                        {renderTrendBadge(
                          liveSaleor ? liveSaleor.orders : currentAgg.orders,
                          liveSaleor ? liveSaleor.previousOrders : priorAgg?.orders,
                          false,
                          { showContext: true, compactContext: true },
                        )}
                      </div>
                      <span>Reporting days in {timezone} · hover points for values</span>
                    </div>
                  </article>

                  {/* Payment Ring Card */}
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <div>
                        <h2>Payment outcomes</h2>
                        <p>
                          {liveSaleor?.paymentBreakdown
                            ? 'Saleor payment charge status (FULL online vs NONE)'
                            : 'Distinct online attempts · illustrative mapping'}
                        </p>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        {/* View Toggle */}
                        <div className={styles.viewToggleGroup}>
                          <button
                            type="button"
                            className={`${styles.viewToggleBtn} ${paymentView === 'ring' ? styles.viewToggleBtnActive : ''}`}
                            onClick={() => setPaymentView('ring')}
                            title="Show payment ring and breakdown"
                          >
                            🍩 Ring
                          </button>
                          <button
                            type="button"
                            className={`${styles.viewToggleBtn} ${paymentView === 'trend' ? styles.viewToggleBtnActive : ''}`}
                            onClick={() => setPaymentView('trend')}
                            title="Show daily payment outcomes trend"
                          >
                            📈 Daily Trend
                          </button>
                        </div>
                        {renderTrendBadge(
                          liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.onlineRate : currPaymentRate,
                          liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.priorOnlineRate : priorPaymentRate,
                          true,
                          { showContext: true, compactContext: true },
                        )}
                        {liveSaleor?.paymentBreakdown ? (
                          <span className={`${styles.badge} ${styles.badgeLive}`}>● LIVE PROD</span>
                        ) : (
                          <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                        )}
                      </div>
                    </div>
                    {paymentView === 'trend' ? (
                      <div className={styles.cardbody} style={{ padding: '12px 14px' }}>
                        <div className={styles.chartWrapper}>
                          {paymentHover && (
                            <div
                              className={styles.chartTooltip}
                              style={{
                                left: `${(paymentHover.x / paymentChartW) * 100}%`,
                                top: `${(paymentHover.y / paymentChartH) * 100}%`,
                              }}
                            >
                              <div className={styles.chartTooltipHeader}>
                                <span>📅 {formatChartDate(paymentHover.date)}</span>
                                <span style={{ color: '#7be3a7' }}>● Online Captured</span>
                              </div>
                              <div className={styles.chartTooltipValue}>
                                <span>{paymentHover.rate.toFixed(1)}%</span>
                                <span style={{ fontSize: '11px', fontWeight: 500, color: '#a3b5a8' }}>success rate</span>
                              </div>
                              <div className={styles.chartTooltipSubtext} style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px' }}>
                                <span><span style={{ color: '#5a8263' }}>●</span> Captured Online: <b>{fmt(paymentHover.captured)}</b></span>
                                <span><span style={{ color: '#d6978a' }}>●</span> Cash / Uncharged: <b>{fmt(paymentHover.cash)}</b></span>
                                <span>Total Orders: <b>{fmt(paymentHover.captured + paymentHover.cash)}</b></span>
                              </div>
                            </div>
                          )}

                          <svg className={styles.chart} viewBox={`0 0 ${paymentChartW} ${paymentChartH}`} style={{ height: '180px' }}>
                            {/* Horizontal guide lines */}
                            {[0, 1, 2, 3].map((i) => {
                              const v = (maxPaymentDailyOrders * 1.2 * i) / 3
                              const y = getPaymentY(v)
                              return (
                                <g key={i}>
                                  <line
                                    x1={paymentChartLeft}
                                    y1={y}
                                    x2={paymentChartW - paymentChartRight}
                                    y2={y}
                                    stroke="#edf1ec"
                                    strokeDasharray="3 4"
                                  />
                                  <text x="28" y={y + 3} textAnchor="end" className={styles.charttext}>
                                    {Math.round(v)}
                                  </text>
                                </g>
                              )
                            })}

                            {/* X axis dates */}
                            {paymentDailyPoints.map((p, i) => {
                              const step = paymentDailyPoints.length > 14 ? 3 : paymentDailyPoints.length > 7 ? 2 : 1
                              if (i % step !== 0 && i !== paymentDailyPoints.length - 1) return null
                              const dayPart = p.date.split('-').slice(1).join('/')
                              return (
                                <text
                                  key={`pdate-${p.date}`}
                                  x={getPaymentX(i)}
                                  y={paymentChartH - 8}
                                  textAnchor="middle"
                                  className={styles.charttext}
                                  style={{
                                    fontSize: '9px',
                                    fill: paymentHover?.date === p.date ? '#1a7f5a' : '#8b958f',
                                    fontWeight: paymentHover?.date === p.date ? 700 : 400,
                                  }}
                                >
                                  {dayPart}
                                </text>
                              )
                            })}

                            {/* Hover Guideline */}
                            {paymentHover && (
                              <>
                                <line
                                  x1={paymentHover.x}
                                  y1={paymentChartTop}
                                  x2={paymentHover.x}
                                  y2={paymentChartH - paymentChartBottom}
                                  stroke="#5a8263"
                                  strokeWidth="1.2"
                                  strokeDasharray="3 3"
                                  opacity="0.6"
                                />
                                <circle
                                  cx={paymentHover.x}
                                  cy={paymentHover.y}
                                  r="8"
                                  fill="#5a8263"
                                  opacity="0.2"
                                />
                              </>
                            )}

                            {/* Captured Line */}
                            <path
                              d={paymentDailyPoints
                                .map((p, i) => `${i ? 'L' : 'M'}${getPaymentX(i).toFixed(1)},${getPaymentY(p.captured).toFixed(1)}`)
                                .join(' ')}
                              fill="none"
                              stroke="#5a8263"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />

                            {/* Cash Line */}
                            <path
                              d={paymentDailyPoints
                                .map((p, i) => `${i ? 'L' : 'M'}${getPaymentX(i).toFixed(1)},${getPaymentY(p.cash).toFixed(1)}`)
                                .join(' ')}
                              fill="none"
                              stroke="#d6978a"
                              strokeWidth="2"
                              strokeDasharray="3 3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />

                            {/* Date Dots on Captured Line */}
                            {paymentDailyPoints.map((p, i) => {
                              const cx = getPaymentX(i)
                              const cy = getPaymentY(p.captured)
                              const isHovered = paymentHover?.date === p.date
                              return (
                                <g key={p.date}>
                                  <circle
                                    cx={cx}
                                    cy={cy}
                                    r={isHovered ? 5.5 : 3.5}
                                    fill={isHovered ? '#5a8263' : '#ffffff'}
                                    stroke="#5a8263"
                                    strokeWidth={isHovered ? 2.5 : 2}
                                    style={{ transition: 'r 0.15s ease' }}
                                  />
                                  {/* Hit Target */}
                                  <circle
                                    cx={cx}
                                    cy={cy}
                                    r="14"
                                    fill="transparent"
                                    className={styles.chartHitArea}
                                    onMouseEnter={() =>
                                      setPaymentHover({
                                        date: p.date,
                                        rate: p.ratePct,
                                        captured: p.captured,
                                        cash: p.cash,
                                        x: cx,
                                        y: cy,
                                      })
                                    }
                                    onMouseMove={() =>
                                      setPaymentHover({
                                        date: p.date,
                                        rate: p.ratePct,
                                        captured: p.captured,
                                        cash: p.cash,
                                        x: cx,
                                        y: cy,
                                      })
                                    }
                                    onMouseLeave={() => setPaymentHover(null)}
                                  />
                                </g>
                              )
                            })}
                          </svg>
                        </div>
                        <div className={styles.legend} style={{ marginTop: '8px', justifyContent: 'center' }}>
                          <span><i style={{ background: '#5a8263' }}></i>Online Captured ({fmt(liveSaleor?.paymentBreakdown?.fullCharge ?? currentAgg.success)})</span>
                          <span><i style={{ background: '#d6978a' }}></i>Cash / Uncharged ({fmt(liveSaleor?.paymentBreakdown?.noneCharge ?? currentAgg.cash)})</span>
                        </div>
                      </div>
                    ) : (
                    <div className={styles.cardbody}>
                      <div className={styles.paymentRing}>
                        <div className={styles.ring}>
                          <svg viewBox="0 0 140 140">
                            <circle cx="70" cy="70" r="58" fill="none" stroke="#f0f3ee" strokeWidth="11" />
                            <circle
                              cx="70"
                              cy="70"
                              r="58"
                              fill="none"
                              stroke="#5a8263"
                              strokeWidth="11"
                              strokeDasharray={ringDash}
                              strokeLinecap="round"
                            />
                          </svg>
                          <div className={styles.ringtext}>
                            <b>
                              {liveSaleor?.paymentBreakdown
                                ? `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}%`
                                : pct(currentAgg.success, currentAgg.attempts)}
                            </b>
                            <span>{liveSaleor?.paymentBreakdown ? 'captured online' : 'confirmed success'}</span>
                            <div style={{ marginTop: '3px' }}>
                              {renderTrendBadge(
                                liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.onlineRate : currPaymentRate,
                                liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.priorOnlineRate : priorPaymentRate,
                                true,
                              )}
                            </div>
                          </div>
                        </div>
                        <div className={styles.ringlegend}>
                          {liveSaleor?.paymentBreakdown ? (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span><span className={styles.dot} style={{ color: '#5a8263' }}></span>Captured <b>{fmt(liveSaleor.paymentBreakdown.fullCharge)}</b></span>
                                {renderTrendBadge(
                                  liveSaleor.paymentBreakdown.fullCharge,
                                  liveSaleor.paymentBreakdown.priorFullCharge,
                                  false,
                                )}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span><span className={styles.dot} style={{ color: '#d6978a' }}></span>Uncharged / Cash <b>{fmt(liveSaleor.paymentBreakdown.noneCharge)}</b></span>
                                {renderTrendBadge(
                                  liveSaleor.paymentBreakdown.noneCharge,
                                  liveSaleor.paymentBreakdown.priorNoneCharge,
                                  false,
                                )}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span><span className={styles.dot} style={{ color: '#507b5b' }}></span>Total Orders <b>{fmt(liveSaleor.orders)}</b></span>
                                {renderTrendBadge(
                                  liveSaleor.orders,
                                  liveSaleor.previousOrders,
                                  false,
                                )}
                              </div>
                            </>
                          ) : (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span><span className={styles.dot} style={{ color: '#5a8263' }}></span>Success <b>{fmt(currentAgg.success)}</b></span>
                                {renderTrendBadge(currentAgg.success, priorAgg?.success, false)}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span><span className={styles.dot} style={{ color: '#d6978a' }}></span>Failed <b>{fmt(currentAgg.failed)}</b></span>
                                {renderTrendBadge(currentAgg.failed, priorAgg?.failed, false)}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span><span className={styles.dot} style={{ color: '#d6dccc' }}></span>Pending <b>{fmt(currentAgg.pending)}</b></span>
                                {renderTrendBadge(currentAgg.pending, priorAgg?.pending, false)}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      <div className={styles.ruleline}></div>
                      <div className={styles.minirow}>
                        <span>{liveSaleor?.paymentBreakdown ? 'Online captured orders' : 'Online payment attempts'}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <strong>
                            {liveSaleor?.paymentBreakdown
                              ? fmt(liveSaleor.paymentBreakdown.fullCharge)
                              : fmt(currentAgg.attempts)}
                          </strong>
                          {renderTrendBadge(
                            liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.fullCharge : currentAgg.attempts,
                            liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.priorFullCharge : priorAgg?.attempts,
                            false,
                            { showContext: true, compactContext: true },
                          )}
                        </div>
                      </div>
                      <div className={styles.minirow}>
                        <span>{liveSaleor?.paymentBreakdown ? 'Cash / uncharged orders' : 'Cash orders · excluded from rate'}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <strong>
                            {liveSaleor?.paymentBreakdown
                              ? fmt(liveSaleor.paymentBreakdown.noneCharge)
                              : fmt(currentAgg.cash)}
                          </strong>
                          {renderTrendBadge(
                            liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.noneCharge : currentAgg.cash,
                            liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.priorNoneCharge : priorAgg?.cash,
                            false,
                            { showContext: true, compactContext: true },
                          )}
                        </div>
                      </div>
                      <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #edf1ec' }}>
                        {renderTrend(
                          liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.onlineRate : currPaymentRate,
                          liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.priorOnlineRate : priorPaymentRate,
                          true,
                          <span>
                            {liveSaleor?.paymentBreakdown
                              ? 'Charge status FULL indicates online settlement confirmed by Saleor.'
                              : 'Success means a confirmed gateway outcome, not HTTP 200.'}
                          </span>,
                        )}
                      </div>
                    </div>
                  )}
                  </article>
                </div>

                <div className={`${styles.notice} ${styles.noticeInfo}`}>
                  <div>
                    <b>Placed is not the same as received in OMS.</b> Reconcile the same order ID across
                    Saleor and OMS; never add their counts together. These deterministic fixtures
                    illustrate a handoff gap.
                  </div>
                </div>

                <div className={styles.gridMain}>
                  {/* Country Table Card */}
                  {/* Country Performance Card: Trend Chart & Table Dual View */}
                  <article className={styles.card}>
                    <div className={styles.cardhead} style={{ paddingBottom: '14px' }}>
                      <div>
                        <h2>Country performance</h2>
                        <p>
                          {countryView === 'chart'
                            ? 'Daily order trends by business country · hover dots for exact values of that day'
                            : liveSaleor?.countryBreakdown
                            ? 'Live country channel distribution directly from Saleor'
                            : 'Country from order/channel data · never inferred from IP'}
                        </p>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        {/* View Toggle */}
                        <div className={styles.viewToggleGroup}>
                          <button
                            type="button"
                            className={`${styles.viewToggleBtn} ${countryView === 'chart' ? styles.viewToggleBtnActive : ''}`}
                            onClick={() => setCountryView('chart')}
                            title="Show multi-line country trend chart"
                          >
                            📈 Trend Chart
                          </button>
                          <button
                            type="button"
                            className={`${styles.viewToggleBtn} ${countryView === 'table' ? styles.viewToggleBtnActive : ''}`}
                            onClick={() => setCountryView('table')}
                            title="Show detailed tabular breakdown"
                          >
                            📋 Table View
                          </button>
                        </div>
                        {renderTrendBadge(
                          liveSaleor ? liveSaleor.orders : currentAgg.orders,
                          liveSaleor ? liveSaleor.previousOrders : priorAgg?.orders,
                          false,
                          { showContext: true, compactContext: true },
                        )}
                        {liveSaleor?.countryBreakdown ? (
                          <span className={`${styles.badge} ${styles.badgeLive}`}>● LIVE PROD</span>
                        ) : (
                          <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                        )}
                      </div>
                    </div>

                    {countryView === 'chart' ? (
                      /* MULTI-LINE COUNTRY TREND CHART VIEW */
                      <div className={styles.cardbody} style={{ padding: 0 }}>
                        {/* Interactive Country Legend Bar */}
                        <div className={styles.countryLegendBar}>
                          <span style={{ fontSize: '10px', fontWeight: 700, color: '#727e77', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            Countries:
                          </span>
                          {Object.entries(countries).map(([code, c]) => {
                            const meta = COUNTRY_COLORS[code] || { color: '#68726e', name: c.name, flag: code }
                            const ordersCount = liveSaleor?.countryBreakdown
                              ? (liveSaleor.countryBreakdown[code] ?? 0)
                              : aggregate(currentRecords.filter((r) => r.code === code)).orders
                            const isFocused = focusedCountry === code
                            return (
                              <button
                                key={code}
                                type="button"
                                className={styles.countryLegendItem}
                                style={{
                                  background: isFocused ? '#e8f2eb' : undefined,
                                  borderColor: isFocused ? meta.color : 'transparent',
                                  opacity: focusedCountry && !isFocused ? 0.45 : 1,
                                }}
                                onClick={() => setFocusedCountry((prev) => (prev === code ? null : code))}
                                title={`Click to ${isFocused ? 'show all countries' : `isolate ${c.name}`}`}
                              >
                                <span className={styles.countryLegendDot} style={{ background: meta.color }} />
                                <span>{code} · {c.name}</span>
                                <b className={styles.countryLegendCount}>({fmt(ordersCount)})</b>
                              </button>
                            )
                          })}
                          {focusedCountry && (
                            <button
                              type="button"
                              className={styles.btnText}
                              style={{ fontSize: '10px', color: '#1a7f5a', padding: '2px 6px', cursor: 'pointer', background: 'none', border: 'none' }}
                              onClick={() => setFocusedCountry(null)}
                            >
                              Show all lines
                            </button>
                          )}
                        </div>

                        {/* Chart with Interactive Date Dots and Guideline */}
                        <div className={styles.chartWrapper} style={{ padding: '12px 18px 6px' }}>
                          {countryHover && (() => {
                            const xRatio = countryHover.x / countryChartW
                            const yRatio = countryHover.y / countryChartH
                            const isHigh = yRatio < 0.48
                            const isRight = xRatio > 0.68
                            const isLeft = xRatio < 0.28

                            return (
                              <div
                                className={`${styles.chartTooltip} ${isHigh ? styles.chartTooltipBottom : ''} ${
                                  isRight ? styles.chartTooltipRight : isLeft ? styles.chartTooltipLeft : ''
                                }`}
                                style={{
                                  left: `calc(18px + ${(countryHover.x / countryChartW)} * (100% - 36px))`,
                                  top: `${12 + countryHover.y}px`,
                                }}
                              >
                              <div className={styles.chartTooltipHeader}>
                                <span>📅 {formatChartDate(countryHover.date)}</span>
                                <span style={{ color: '#7be3a7' }}>● Country Daily</span>
                              </div>
                              {countryHover.name && countryHover.orders !== undefined && (
                                <div className={styles.chartTooltipValue} style={{ color: '#ffffff', marginBottom: '4px' }}>
                                  <span style={{ color: COUNTRY_COLORS[countryHover.code || '']?.color || '#507b5b' }}>
                                    {countryHover.code}
                                  </span>
                                  <span>{fmt(countryHover.orders)} orders</span>
                                </div>
                              )}
                              <div style={{ borderTop: '1px solid #2a3a2e', paddingTop: '4px', marginTop: '4px' }}>
                                {countryHover.items.map((it) => (
                                  <div key={it.code} className={styles.chartTooltipCountryRow}>
                                    <span className={styles.chartTooltipCountryFlag}>
                                      <span className={styles.chartTooltipCountryDot} style={{ background: it.color }} />
                                      {it.code} · {it.name}
                                    </span>
                                    <b style={{ color: it.code === countryHover.code ? '#7be3a7' : '#ffffff' }}>
                                      {fmt(it.orders)}
                                    </b>
                                  </div>
                                ))}
                                <div style={{ borderTop: '1px dashed #34483a', marginTop: '4px', paddingTop: '4px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#a3b5a8' }}>
                                  <span>Total that day:</span>
                                  <b style={{ color: '#ffffff' }}>
                                    {fmt(countryHover.items.reduce((acc, cur) => acc + cur.orders, 0))}
                                  </b>
                                </div>
                              </div>
                            </div>
                          )})()}

                          <svg className={styles.chart} viewBox={`0 0 ${countryChartW} ${countryChartH}`} style={{ height: '260px' }}>
                            {/* Horizontal guide lines */}
                            {[0, 1, 2, 3, 4].map((i) => {
                              const v = (maxCountryDailyVal * 1.25 * i) / 4
                              const y = getCountryY(v)
                              return (
                                <g key={i}>
                                  <line
                                    x1={countryChartLeft}
                                    y1={y}
                                    x2={countryChartW - countryChartRight}
                                    y2={y}
                                    stroke="#edf1ec"
                                    strokeDasharray="3 4"
                                  />
                                  <text x="32" y={y + 3} textAnchor="end" className={styles.charttext}>
                                    {Math.round(v)}
                                  </text>
                                </g>
                              )
                            })}

                            {/* X-axis date labels */}
                            {countryDates.map((dStr, i) => {
                              const step = countryDates.length > 14 ? 3 : countryDates.length > 7 ? 2 : 1
                              if (i % step !== 0 && i !== countryDates.length - 1) return null
                              const dayPart = dStr.split('-').slice(1).join('/')
                              return (
                                <text
                                  key={`cdate-${dStr}`}
                                  x={getCountryX(i)}
                                  y={countryChartH - 12}
                                  textAnchor="middle"
                                  className={styles.charttext}
                                  style={{
                                    fontSize: '9px',
                                    fill: countryHover?.date === dStr ? '#1a7f5a' : '#8b958f',
                                    fontWeight: countryHover?.date === dStr ? 700 : 400,
                                  }}
                                >
                                  {dayPart}
                                </text>
                              )
                            })}

                            {/* Vertical Guideline on Hover */}
                            {countryHover && (
                              <>
                                <line
                                  x1={countryHover.x}
                                  y1={countryChartTop}
                                  x2={countryHover.x}
                                  y2={countryChartH - countryChartBottom}
                                  stroke="#507b5b"
                                  strokeWidth="1.2"
                                  strokeDasharray="3 3"
                                  opacity="0.6"
                                />
                                <circle
                                  cx={countryHover.x}
                                  cy={countryHover.y}
                                  r="8"
                                  fill={COUNTRY_COLORS[countryHover.code || '']?.color || '#507b5b'}
                                  opacity="0.25"
                                />
                              </>
                            )}

                            {/* Multi-line Country Trends */}
                            {Object.entries(countryDailyData).map(([code, pts]) => {
                              if (country !== 'all' && country !== code) return null
                              const meta = COUNTRY_COLORS[code] || { color: '#68726e', name: code, flag: code }
                              const isFocused = focusedCountry === code
                              const isDimmed = focusedCountry !== null && focusedCountry !== code
                              const lineD = pts
                                .map((p, i) => `${i ? 'L' : 'M'}${getCountryX(i).toFixed(1)},${getCountryY(p.orders).toFixed(1)}`)
                                .join(' ')

                              return (
                                <g key={code} opacity={isDimmed ? 0.22 : 1} style={{ transition: 'opacity 0.2s ease' }}>
                                  {/* Line */}
                                  <path
                                    d={lineD}
                                    fill="none"
                                    stroke={meta.color}
                                    strokeWidth={isFocused ? 3.5 : 2.4}
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                  />

                                  {/* Date Dots on Country Line */}
                                  {pts.map((p, i) => {
                                    const cx = getCountryX(i)
                                    const cy = getCountryY(p.orders)
                                    const isHovered = countryHover?.date === p.date && countryHover?.code === code
                                    return (
                                      <g key={p.date}>
                                        <circle
                                          cx={cx}
                                          cy={cy}
                                          r={isHovered ? 5.5 : 3.5}
                                          fill={isHovered ? meta.color : '#ffffff'}
                                          stroke={meta.color}
                                          strokeWidth={isHovered ? 2.5 : 2}
                                          style={{ transition: 'r 0.15s ease' }}
                                        />
                                        {/* Hit Area for Smooth Mouse Move */}
                                        <circle
                                          cx={cx}
                                          cy={cy}
                                          r="14"
                                          fill="transparent"
                                          className={styles.chartHitArea}
                                          onMouseEnter={() => {
                                            const dayItems = Object.entries(countryDailyData)
                                              .map(([cCode, cPts]) => ({
                                                code: cCode,
                                                name: COUNTRY_COLORS[cCode]?.name || cCode,
                                                orders: cPts[i]?.orders ?? 0,
                                                color: COUNTRY_COLORS[cCode]?.color || '#888',
                                              }))
                                              .sort((a, b) => b.orders - a.orders)

                                            setCountryHover({
                                              date: p.date,
                                              code,
                                              name: meta.name,
                                              orders: p.orders,
                                              x: cx,
                                              y: cy,
                                              items: dayItems,
                                            })
                                          }}
                                          onMouseMove={() => {
                                            if (countryHover?.date !== p.date || countryHover?.code !== code) {
                                              const dayItems = Object.entries(countryDailyData)
                                                .map(([cCode, cPts]) => ({
                                                  code: cCode,
                                                  name: COUNTRY_COLORS[cCode]?.name || cCode,
                                                  orders: cPts[i]?.orders ?? 0,
                                                  color: COUNTRY_COLORS[cCode]?.color || '#888',
                                                }))
                                                .sort((a, b) => b.orders - a.orders)

                                              setCountryHover({
                                                date: p.date,
                                                code,
                                                name: meta.name,
                                                orders: p.orders,
                                                x: cx,
                                                y: cy,
                                                items: dayItems,
                                              })
                                            }
                                          }}
                                          onMouseLeave={() => setCountryHover(null)}
                                        />
                                      </g>
                                    )
                                  })}
                                </g>
                              )
                            })}
                          </svg>
                        </div>
                      </div>
                    ) : (
                      /* TABULAR COUNTRY VIEW WITH MINI SPARKLINES AND DOTS */
                      <div className={styles.tablewrap}>
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <th>COUNTRY</th>
                              <th className={styles.num}>ORDERS</th>
                              <th className={styles.num}>TREND & DAILY POINTS</th>
                              <th className={styles.num}>SHARE</th>
                              <th className={styles.num}>PAYMENT SUCCESS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(countries)
                              .filter(([c]) => country === 'all' || c === country)
                              .map(([code, c]) => {
                                const countryRows = currentRecords.filter((r) => r.code === code)
                                const x = aggregate(countryRows)
                                const ordersCount = liveSaleor?.countryBreakdown
                                  ? (liveSaleor.countryBreakdown[code] ?? 0)
                                  : x.orders
                                const priorOrdersCount = liveSaleor?.priorCountryBreakdown
                                  ? (liveSaleor.priorCountryBreakdown[code] ?? 0)
                                  : priorAgg
                                  ? aggregate(priorRecords.filter((r) => r.code === code)).orders
                                  : undefined
                                const totalOrders = liveSaleor ? liveSaleor.orders : currentAgg.orders
                                const sharePct = totalOrders > 0 ? (ordersCount / totalOrders) * 100 : 0
                                const pts = countryDailyData[code] || []
                                const maxPts = Math.max(1, ...pts.map((p) => p.orders))

                                return (
                                  <tr key={code}>
                                    <td>
                                      <span className={styles.countryflag}>{code}</span>
                                      {c.name}
                                    </td>
                                    <td className={styles.num}><b>{fmt(ordersCount)}</b></td>
                                    <td className={styles.num}>
                                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end' }}>
                                        {/* Inline Mini Sparkline with Hover Dots */}
                                        {pts.length > 1 && (
                                          <svg width="68" height="20" className={styles.tableSparkline}>
                                            <polyline
                                              fill="none"
                                              stroke={COUNTRY_COLORS[code]?.color || '#507b5b'}
                                              strokeWidth="1.5"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              points={pts
                                                .map((p, i) => `${(i / (pts.length - 1)) * 64 + 2},${18 - (p.orders / maxPts) * 15}`)
                                                .join(' ')}
                                            />
                                            {pts.map((p, i) => {
                                              const cx = (i / (pts.length - 1)) * 64 + 2
                                              const cy = 18 - (p.orders / maxPts) * 15
                                              return (
                                                <circle
                                                  key={p.date}
                                                  cx={cx}
                                                  cy={cy}
                                                  r="2"
                                                  fill="#ffffff"
                                                  stroke={COUNTRY_COLORS[code]?.color || '#507b5b'}
                                                  strokeWidth="1"
                                                >
                                                  <title>{`${formatChartDate(p.date)}: ${fmt(p.orders)} orders`}</title>
                                                </circle>
                                              )
                                            })}
                                          </svg>
                                        )}
                                        {renderTrendBadge(ordersCount, priorOrdersCount, false, {
                                          showContext: true,
                                          compactContext: true,
                                        })}
                                      </div>
                                    </td>
                                    <td className={styles.num}>
                                      <span className={styles.inlinebar}>
                                        <i style={{ width: `${Math.min(100, sharePct)}%`, background: COUNTRY_COLORS[code]?.color }}></i>
                                      </span>
                                      {sharePct.toFixed(1)}%
                                    </td>
                                    <td className={styles.num}>
                                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', justifyContent: 'flex-end' }}>
                                        <span>
                                          {liveSaleor?.paymentBreakdown
                                            ? `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}%`
                                            : pct(x.success, x.attempts)}
                                        </span>
                                        {renderTrendBadge(
                                          liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.onlineRate : (x.attempts ? (x.success / x.attempts) * 100 : 0),
                                          liveSaleor?.paymentBreakdown ? liveSaleor.paymentBreakdown.priorOnlineRate : (priorAgg && priorAgg.attempts ? (priorAgg.success / priorAgg.attempts) * 100 : null),
                                          true,
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )
                              })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div className={styles.chartfooter}>
                      {countryView === 'chart'
                        ? `Multi-line country trends in ${timezone} · hover any date dot to inspect that day · click a country in legend to isolate.`
                        : liveSaleor
                        ? `Business-country live orders mapped directly from Saleor · Trends compared vs ${comparisonWindowLabel}.`
                        : `Business-country filters require validated brand/channel mappings · Trends compared vs ${comparisonWindowLabel}.`}
                    </div>
                  </article>

                  {/* Mini Funnel Card */}
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <div>
                        <h2>Customer journey</h2>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
                          <span style={{ fontSize: '11px', color: '#727e77' }}>Overall conversion: <b>{currConvRate.toFixed(1)}%</b></span>
                          {renderTrendBadge(currConvRate, priorConvRate, true, { showContext: true, compactContext: true })}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnText}`}
                        onClick={() => setSection('journey')}
                      >
                        Explore journey →
                      </button>
                    </div>
                    <div className={styles.cardbody}>
                      <div className={styles.funnelmini}>
                        {currentAgg.steps.map((n, i) => {
                          const maxStep = Math.max(...currentAgg.steps, 1)
                          const labels = [
                            'Add to cart',
                            'View cart',
                            'Checkout',
                            'Shipping',
                            'Payment',
                            'Attempt',
                            'Confirmed',
                          ]
                          const priorStepN = priorAgg?.steps?.[i]
                          return (
                            <div key={i} className={styles.funnelcol}>
                              <b>{fmt(n)}</b>
                              <div
                                className={styles.funnelbar}
                                style={{ height: `${Math.max(8, (n / maxStep) * 80)}px` }}
                              ></div>
                              <span>{labels[i]}</span>
                              {priorStepN !== undefined && (
                                <div
                                  style={{
                                    fontSize: '9px',
                                    fontWeight: 700,
                                    color: n >= priorStepN ? '#1a7f5a' : '#b13736',
                                    marginTop: '2px',
                                  }}
                                  title={`vs ${comparisonWindowLabel} (${fmt(priorStepN)})`}
                                >
                                  {n >= priorStepN ? '↑ +' : '↓ -'}
                                  {priorStepN === 0
                                    ? '0%'
                                    : `${Math.abs(((n - priorStepN) / priorStepN) * 100).toFixed(0)}%`}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <div className={styles.definition}>
                        Synthetic journey IDs, not actual users. Existing checkout-state data cannot
                        reconstruct these steps.
                      </div>
                    </div>
                  </article>
                </div>

                {/* Revenue Card */}
                <div className={styles.card} style={{ marginTop: '20px' }}>
                  <div className={styles.sourceStrip}>
                    <div>
                      <strong>Revenue stays in its original currency</strong>
                      <p>
                        {liveSaleor?.revenueByCurrency
                          ? 'Gross order value directly from Saleor live orders · no FX conversion'
                          : 'Illustrative gross order value · no FX conversion or cross-currency total'}
                      </p>
                    </div>
                    {liveSaleor?.revenueByCurrency ? (
                      <span className={`${styles.badge} ${styles.badgeLive}`}>● LIVE PROD</span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    )}
                  </div>
                  <div className={styles.cardbody}>
                    {renderRevenueCurrencyCards(true)}
                  </div>
                </div>
              </>
            )}

            {/* ORDERS & PAYMENTS SECTION */}
            {section === 'orders' && (
              <>
                <div className={styles.metrics}>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Confirmed orders</span>
                      {liveSaleor ? (
                        <span style={{ fontSize: '10px', background: '#e1f5ec', color: '#1a7f5a', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● LIVE PROD
                        </span>
                      ) : (
                        <span style={{ fontSize: '10px', background: '#f0f2f1', color: '#68726e', padding: '2px 6px', borderRadius: '4px' }}>
                          {liveLoading ? 'LOADING...' : 'FIXTURE'}
                        </span>
                      )}
                    </div>
                    <div className={styles.metricValueRow}>
                      <div className={styles.metricvalue}>
                        {liveSaleor ? (
                          fmt(liveSaleor.orders)
                        ) : liveLoading ? (
                          <span className={styles.skeletonPulse}>—</span>
                        ) : (
                          fmt(currentAgg.orders)
                        )}
                      </div>
                      <MiniSparkline data={ordersSparkline} />
                    </div>
                    <div className={styles.metricfoot}>
                      {liveSaleor ? (
                        renderTrend(
                          liveSaleor.orders,
                          liveSaleor.previousOrders,
                          false,
                          <span>{fmt(liveSaleor.todaySoFar)} today</span>,
                        )
                      ) : liveLoading ? (
                        <span>Connecting live Saleor feed...</span>
                      ) : (
                        renderTrend(currentAgg.orders, priorAgg?.orders)
                      )}
                    </div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Online attempts</span>
                      {liveSaleor?.paymentBreakdown ? (
                        <span style={{ fontSize: '10px', background: '#e1f5ec', color: '#1a7f5a', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● LIVE PROD
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.metricvalue}>
                      {liveSaleor?.paymentBreakdown ? fmt(liveSaleor.paymentBreakdown.fullCharge) : fmt(currentAgg.attempts)}
                    </div>
                    <div className={styles.metricfoot}>
                      {liveSaleor?.paymentBreakdown ? 'Captured online orders' : 'Retry-deduplicated event concept'}
                    </div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Payment successes</span>
                      {liveSaleor?.paymentBreakdown ? (
                        <span style={{ fontSize: '10px', background: '#e1f5ec', color: '#1a7f5a', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● LIVE PROD
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.metricValueRow}>
                      <div className={styles.metricvalue}>
                        {liveSaleor?.paymentBreakdown ? fmt(liveSaleor.paymentBreakdown.fullCharge) : fmt(currentAgg.success)}
                      </div>
                      <MiniSparkline data={paymentSparkline} />
                    </div>
                    <div className={styles.metricfoot}>
                      {liveSaleor?.paymentBreakdown ? (
                        renderTrend(
                          liveSaleor.paymentBreakdown.onlineRate,
                          liveSaleor.paymentBreakdown.priorOnlineRate,
                          true,
                          <span>{liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}% online success rate</span>,
                        )
                      ) : (
                        renderTrend(
                          currPaymentRate,
                          priorPaymentRate,
                          true,
                          <span>Gateway confirmed · demo outcomes</span>,
                        )
                      )}
                    </div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Cash orders</span>
                      {liveSaleor?.paymentBreakdown ? (
                        <span style={{ fontSize: '10px', background: '#e1f5ec', color: '#1a7f5a', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ● LIVE PROD
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.metricvalue}>
                      {liveSaleor?.paymentBreakdown ? fmt(liveSaleor.paymentBreakdown.noneCharge) : fmt(currentAgg.cash)}
                    </div>
                    <div className={styles.metricfoot}>
                      {liveSaleor?.paymentBreakdown ? 'Uncharged / Cash on Delivery' : 'Not an online authorization metric'}
                    </div>
                  </div>
                </div>

                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.cardhead} style={{ paddingBottom: '18px' }}>
                    <div>
                      <h2>Payment gateway performance</h2>
                      <p>
                        {liveSaleor?.gatewayCounts
                          ? 'Extracted from live Macula OMS order payment records'
                          : 'Success + failed + pending = attempts'}
                      </p>
                    </div>
                    {liveSaleor?.gatewayCounts ? (
                      <span className={`${styles.badge} ${styles.badgeLive}`}>● LIVE PROD</span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgePending}`}>INTEGRATION PENDING</span>
                    )}
                  </div>
                  <div className={styles.tablewrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>GATEWAY</th>
                          <th className={styles.num}>ORDERS</th>
                          <th className={styles.num}>SHARE</th>
                          <th className={styles.num}>{liveSaleor?.gatewayCounts ? 'STATUS' : 'SUCCESS RATE'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {liveSaleor?.gatewayCounts ? (
                          Object.entries(liveSaleor.gatewayCounts).map(([gw, count]) => {
                            const totalGw = Object.values(liveSaleor.gatewayCounts || {}).reduce((a, b) => a + b, 0) || 1
                            const share = ((count / totalGw) * 100).toFixed(1)
                            return (
                              <tr key={gw}>
                                <td><strong>{gw}</strong></td>
                                <td className={styles.num}><b>{fmt(count)}</b></td>
                                <td className={styles.num}>
                                  <span className={styles.inlinebar}>
                                    <i style={{ width: `${share}%` }}></i>
                                  </span>
                                  {share}%
                                </td>
                                <td className={styles.num}>
                                  <span style={{ color: '#1a7f5a', fontWeight: 650 }}>● Active</span>
                                </td>
                              </tr>
                            )
                          })
                        ) : (
                          ['Checkout.com', 'Tabby', 'Tamara', 'Paymob'].map((gw, i) => {
                            const weights = [55, 18, 17, 10]
                            const atts = split(currentAgg.attempts, weights)[i]
                            const succ = split(currentAgg.success, weights)[i]
                            const fail = split(currentAgg.failed, weights)[i]
                            const pend = split(currentAgg.pending, weights)[i]
                            return (
                              <tr key={gw}>
                                <td><strong>{gw}</strong></td>
                                <td className={styles.num}>{fmt(atts)}</td>
                                <td className={styles.num}>{fmt(succ)}</td>
                                <td className={styles.num}>{fmt(fail)}</td>
                                <td className={styles.num}>{fmt(pend)}</td>
                                <td className={styles.num}>{pct(succ, atts)}</td>
                              </tr>
                            )
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </article>

                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.cardhead} style={{ paddingBottom: '16px' }}>
                    <div>
                      <h2>Payment method-wise distribution</h2>
                      <p>
                        {liveSaleor?.methodCounts
                          ? 'Derived from live OMS order payment backend and type attributes · Apple Pay and KNET are methods; Checkout.com and Paymob are gateways.'
                          : 'Apple Pay and KNET are methods; Checkout.com and Paymob are gateways.'}
                      </p>
                    </div>
                    {liveSaleor?.methodCounts ? (
                      <span className={`${styles.badge} ${styles.badgeLive}`}>● LIVE PROD</span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    )}
                  </div>
                  <div className={styles.cardbody}>
                    <div className={styles.methodCardsGrid}>
                      {liveSaleor?.methodCounts ? (
                        Object.entries(liveSaleor.methodCounts).map(([m, count]) => {
                          const totalMethods =
                            Object.values(liveSaleor.methodCounts || {}).reduce((a, b) => a + b, 0) || 1
                          const share = ((count / totalMethods) * 100).toFixed(1)
                          return (
                            <div key={m} className={styles.methodCard}>
                              <div className={styles.methodCardHead}>
                                <span className={styles.methodName}>{m}</span>
                                <span className={styles.methodCount}>{fmt(count)}</span>
                              </div>
                              <div className={styles.methodBarTrack}>
                                <div
                                  className={styles.methodBarFill}
                                  style={{ width: `${Math.min(100, Math.max(parseFloat(share), 4))}%` }}
                                />
                              </div>
                              <div className={styles.methodShareText}>
                                <span>Volume share</span>
                                <b>{share}%</b>
                              </div>
                            </div>
                          )
                        })
                      ) : (
                        ['Card', 'Apple Pay', 'KNET', 'Tabby', 'Tamara', 'Cash'].map((m, i) => {
                          const onlineNums = split(currentAgg.orders - currentAgg.cash, [37, 23, 10, 15, 15])
                          const val = i === 5 ? currentAgg.cash : onlineNums[i]
                          const total = currentAgg.orders || 1
                          const share = ((val / total) * 100).toFixed(1)
                          return (
                            <div key={m} className={styles.methodCard}>
                              <div className={styles.methodCardHead}>
                                <span className={styles.methodName}>{m}</span>
                                <span className={styles.methodCount}>{fmt(val)}</span>
                              </div>
                              <div className={styles.methodBarTrack}>
                                <div
                                  className={styles.methodBarFill}
                                  style={{ width: `${Math.min(100, Math.max(parseFloat(share), 4))}%` }}
                                />
                              </div>
                              <div className={styles.methodShareText}>
                                <span>Volume share</span>
                                <b>{share}%</b>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                    <div className={styles.definition}>
                      {liveSaleor?.methodCounts
                        ? 'Extracted directly from Macula OMS payment attributes and gateway authorization responses.'
                        : 'Apple Pay and KNET are methods; Checkout.com and Paymob are gateways.'}
                    </div>
                  </div>
                </article>

                {/* Revenue Card - Full width likewise to Overview */}
                <article className={styles.card} style={{ marginTop: '20px' }}>
                  <div className={styles.sourceStrip}>
                    <div>
                      <strong>Revenue stays in its original currency</strong>
                      <p>
                        {liveSaleor?.revenueByCurrency
                          ? 'Gross order value directly from Saleor live orders · no FX conversion'
                          : 'Illustrative gross order value · no FX conversion or cross-currency total'}
                      </p>
                    </div>
                    {liveSaleor?.revenueByCurrency ? (
                      <span className={`${styles.badge} ${styles.badgeLive}`}>● LIVE PROD</span>
                    ) : (
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    )}
                  </div>
                  <div className={styles.cardbody}>
                    {renderRevenueCurrencyCards(true)}
                    <div className={styles.definition} style={{ marginTop: '16px' }}>
                      No mixed-currency sum. Production definitions must agree gross/net,
                      cancellations, refunds, and order states.
                    </div>
                  </div>
                </article>
              </>
            )}

            {/* CUSTOMER JOURNEY SECTION */}
            {section === 'journey' && (
              <>
                <div className={`${styles.notice} ${styles.noticeInfo}`}>
                  <div>
                    <b>New browser + server instrumentation required.</b> The current surviving-checkout
                    report is not a user funnel. Completed checkouts may be deleted; their absence
                    cannot measure abandonment.
                  </div>
                </div>

                <div className={styles.metrics}>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Add-to-cart journey IDs</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.steps[0])}</div>
                    <div className={styles.metricfoot}>Synthetic cohort · not unique people</div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Reached checkout</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.steps[2])}</div>
                    <div className={styles.metricfoot}>Proposed browser event</div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Place-order attempts</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.steps[5])}</div>
                    <div className={styles.metricfoot}>Attempt is not a confirmed order</div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Confirmed orders</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.orders)}</div>
                    <div className={styles.metricfoot}>Server/order-feed confirmation</div>
                  </div>
                </div>

                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.cardhead}>
                    <div>
                      <h2>Every step, one consistent cohort</h2>
                      <p>Illustrative counts · same synthetic journey IDs through all steps</p>
                    </div>
                    <span className={`${styles.badge} ${styles.badgePending}`}>REQUIRES EVENTS</span>
                  </div>
                  <div className={styles.cardbody}>
                    <div className={styles.funnelsteps}>
                      {[
                        'Add to cart',
                        'View cart',
                        'Proceed to checkout',
                        'Shipping details',
                        'Payment details',
                        'Place order attempt',
                        'Order confirmed',
                      ].map((name, i) => {
                        const stepVal = currentAgg.steps[i]
                        const baseVal = currentAgg.steps[0]
                        const trackPct = baseVal ? (stepVal / baseVal) * 100 : 0
                        return (
                          <div key={name} className={styles.funnelstep}>
                            <span className={styles.stepnum}>{i + 1}</span>
                            <span className={styles.stepname}>{name}</span>
                            <div className={styles.steptrack}>
                              <i style={{ width: `${Math.max(1, trackPct)}%` }}></i>
                            </div>
                            <span className={styles.stepvalue}>{fmt(stepVal)}</span>
                            <span className={styles.steprate}>
                              {i ? pct(stepVal, currentAgg.steps[i - 1]) + ' step' : '100% start'}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                    <div className={styles.definition}>
                      Count distinct, consented journey IDs per step. Join order confirmation
                      server-side using a pseudonymous correlation ID.
                    </div>
                  </div>
                </article>

                <div className={styles.featureGrid}>
                  <article className={`${styles.card} ${styles.feature}`}>
                    <span className={`${styles.badge} ${styles.badgePending}`}>BROWSER EVENTS</span>
                    <h3>Intent & interaction</h3>
                    <p>
                      Instrument cart, checkout, shipping, payment details and place-order clicks.
                      Record brand, channel, event time and pseudonymous journey ID.
                    </p>
                  </article>
                  <article className={`${styles.card} ${styles.feature}`}>
                    <span className={`${styles.badge} ${styles.badgePending}`}>SERVER CONFIRMATION</span>
                    <h3>Business outcome</h3>
                    <p>
                      Join accepted payment outcomes and confirmed orders. An HTTP 200 cannot
                      substitute for an authoritative order event.
                    </p>
                  </article>
                  <article className={`${styles.card} ${styles.feature}`}>
                    <span className={`${styles.badge} ${styles.badgeGray}`}>OPTIONAL UX CONTEXT</span>
                    <h3>Clarity & GA4</h3>
                    <p>
                      Scheduled cached UX/analytics context only. Quota limits prevent using them as
                      the real-time order alert feed.
                    </p>
                  </article>
                </div>
              </>
            )}

            {/* TRAFFIC & ERRORS SECTION */}
            {section === 'traffic' && (
              <>
                <div className={styles.tabs}>
                  {Object.entries(sources).map(([key, s]) => (
                    <button
                      key={key}
                      type="button"
                      className={`${styles.tabBtn} ${source === key ? styles.tabBtnSelected : ''}`}
                      onClick={() => setSource(key as TrafficSourceKey)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>

                <div className={`${styles.notice} ${styles.noticeInfo}`}>
                  <div>
                    <b>One layer at a time.</b> Never add these source totals: the same request can
                    appear at the edge and again at the origin. {trafficSrc.note}
                  </div>
                </div>

                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.sourceStrip}>
                    <div>
                      <strong>{trafficSrc.name} · {fmt(trafficN)} sample requests</strong>
                      <p>{trafficSrc.origin} · source integration pending</p>
                    </div>
                    <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                  </div>
                  <div className={styles.cardbody}>
                    <div className={styles.pills}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                        <input
                          type="checkbox"
                          checked={filtered}
                          disabled={source !== 'ingress'}
                          onChange={(e) => setFiltered(e.target.checked)}
                        />
                        Exclude identifiable monitors & scripts
                      </label>
                      <span className={styles.tiny}>Ingress only · heuristic, not verified human traffic</span>
                    </div>
                    <div className={styles.definition}>
                      {trafficSrc.coverage} Missing source intervals must show "Not available", never
                      zero.
                    </div>
                  </div>
                </article>

                <div className={styles.codegrid}>
                  {httpCodes.map((c, i) => (
                    <div
                      key={c}
                      className={`${styles.card} ${styles.codecard} ${c.includes('5') ? styles.codecardError : ''}`}
                    >
                      <span className={styles.code}>HTTP {c}</span>
                      <b>{fmt(httpCounts[i])}</b>
                      <p>{pct(httpCounts[i], trafficN)} of this source only</p>
                    </div>
                  ))}
                </div>

                {/* Error Investigation Queue */}
                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.cardhead} style={{ paddingBottom: '18px' }}>
                    <div>
                      <h2>Error investigation queue</h2>
                      <p>Illustrative records only · click to inspect a sanitized sample</p>
                    </div>
                    <span className={`${styles.badge} ${styles.badgeGray}`}>DRILL-DOWN CONCEPT</span>
                  </div>
                  <div className={styles.tablewrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>HTTP</th>
                          <th>SERVICE / ROUTE</th>
                          <th>EXAMPLE SIGNAL</th>
                          <th>CLASSIFICATION</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          className={styles.clickable}
                          onClick={() => setActiveError('graphql')}
                        >
                          <td><span className={`${styles.badge} ${styles.badgeGreen}`}>200</span></td>
                          <td>GraphQL · /graphql/</td>
                          <td>errors[] present</td>
                          <td>Business/application error</td>
                          <td>↗</td>
                        </tr>
                        <tr
                          className={styles.clickable}
                          onClick={() => setActiveError('timeout')}
                        >
                          <td><span className={`${styles.badge} ${styles.badgeRed}`}>504</span></td>
                          <td>Checkout API · /graphql/</td>
                          <td>Upstream deadline exceeded</td>
                          <td>Timeout sample</td>
                          <td>↗</td>
                        </tr>
                        <tr
                          className={styles.clickable}
                          onClick={() => setActiveError('page')}
                        >
                          <td><span className={`${styles.badge} ${styles.badgeRed}`}>500</span></td>
                          <td>Storefront · /ae-en/…</td>
                          <td>Server rendering exception</td>
                          <td>Frontend/server sample</td>
                          <td>↗</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </article>
              </>
            )}

            {/* INFRASTRUCTURE & APM SECTION */}
            {section === 'infra' && (
              <>
                <div className={`${styles.notice} ${styles.noticeInfo}`}>
                  <div>
                    <b>Proposed operational view.</b> All numbers below are fixed sample
                    observations. No service telemetry or distributed tracing is connected.
                  </div>
                </div>

                <div className={styles.featureGrid}>
                  {[
                    ['Saleor admin API', 58, 67, '4 / 4 ready'],
                    ['Saleor checkout API', 39, 54, '4 / 4 ready'],
                    ['GraphQL cache', 24, 42, '8 / 8 ready'],
                  ].map(([name, cpu, mem, pods]) => (
                    <article key={name as string} className={`${styles.card} ${styles.feature}`}>
                      <div className={styles.sourceTitle}>
                        <h3>{name}</h3>
                        <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                      </div>
                      <div className={styles.barpair}>
                        <span>CPU</span>
                        <div className={styles.meter}>
                          <i style={{ width: `${cpu}%` }}></i>
                        </div>
                        <b>{cpu}%</b>
                      </div>
                      <div className={styles.barpair}>
                        <span>Memory</span>
                        <div className={styles.meter}>
                          <i style={{ width: `${mem}%` }}></i>
                        </div>
                        <b>{mem}%</b>
                      </div>
                      <div className={styles.minirow}>
                        <span>Replicas</span>
                        <b>{pods}</b>
                      </div>
                    </article>
                  ))}
                </div>

                <div className={styles.gridHalf}>
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <h2>PostgreSQL & dependencies</h2>
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    </div>
                    <div className={styles.cardbody}>
                      <div className={styles.minirow}>
                        <span>CPU · server capacity</span>
                        <b>38%</b>
                      </div>
                      <div className={styles.minirow}>
                        <span>Active connections / limit</span>
                        <b>84 / 300</b>
                      </div>
                      <div className={styles.minirow}>
                        <span>Queries over 5 minutes</span>
                        <b>2</b>
                      </div>
                      <div className={styles.minirow}>
                        <span>Waiting locks</span>
                        <b>1</b>
                      </div>
                      <div className={styles.definition}>
                        Read-only reporting views only; no database mutation controls in this dashboard.
                      </div>
                    </div>
                  </article>

                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <h2>Service-level indicators</h2>
                      <span className={`${styles.badge} ${styles.badgePending}`}>NEEDS APM</span>
                    </div>
                    <div className={styles.cardbody}>
                      <div className={styles.minirow}>
                        <span>Checkout request p95 · sample</span>
                        <b>820 ms</b>
                      </div>
                      <div className={styles.minirow}>
                        <span>Error-aware GraphQL success</span>
                        <b>Not available</b>
                      </div>
                      <div className={styles.minirow}>
                        <span>Trace coverage</span>
                        <b>Not available</b>
                      </div>
                      <div className={styles.definition}>
                        Missing instrumentation is not zero failures.
                      </div>
                    </div>
                  </article>
                </div>

                {/* Trace Waterfall */}
                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.cardhead}>
                    <div>
                      <h2>Trace waterfall</h2>
                      <p>Illustrative checkout trace · correlation instrumentation required</p>
                    </div>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSmall}`}
                      onClick={() => setActiveError('timeout')}
                    >
                      Inspect sample trace
                    </button>
                  </div>
                  <div className={styles.cardbody}>
                    <div className={styles.trace}>
                      {[
                        ['Browser → checkout', 0, 100, '820ms'],
                        ['Checkout API', 8, 83, '680ms'],
                        ['PostgreSQL query', 13, 24, '197ms'],
                        ['Payment adapter', 41, 47, '385ms'],
                        ['Gateway response', 52, 34, '279ms'],
                      ].map(([n, x, w, time]) => (
                        <div key={n as string} className={styles.traceRow}>
                          <span>{n}</span>
                          <div className={styles.traceTrack}>
                            <i style={{ marginLeft: `${x}%`, width: `${w}%` }}></i>
                          </div>
                          <b>{time}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              </>
            )}

            {/* DATA SOURCES SECTION */}
            {section === 'sources' && (
              <>
                <div className={`${styles.notice} ${styles.noticeInfo}`}>
                  <div>
                    <b>Live telemetry active.</b> Saleor GraphQL API and Macula OMS API are actively connected in live production read-only mode feeding real-time orders, country breakdown, payment outcomes, and native currency revenues. Remaining infrastructure and edge telemetry adapters are pending credential provisioning.
                  </div>
                </div>

                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.flow}>
                    <div>Read-only source adapters</div>
                    <span>→</span>
                    <div>Normalize + deduplicate</div>
                    <span>→</span>
                    <div>Cached aggregates + coverage</div>
                    <span>→</span>
                    <div>Dashboard + alert API</div>
                  </div>
                </article>

                <div className={styles.sourceGrid}>
                  {sourceCatalog.map((s) => (
                    <article key={s.name} className={`${styles.card} ${styles.sourceCard}`}>
                      <div className={styles.sourceTitle}>
                        <div>
                          <h3 style={{ margin: '0 0 5px' }}>{s.name}</h3>
                          <span className={styles.sourcetag}>{s.status}</span>
                        </div>
                        <span className={`${styles.badge} ${s.isLive ? styles.badgeLive : styles.badgePending}`}>{s.badgeText}</span>
                      </div>
                      <p>{s.scope}</p>
                      <dl>
                        <dt>Required next</dt>
                        <dd>{s.need}</dd>
                        <dt>Owner</dt>
                        <dd>{s.owner}</dd>
                        <dt>Connection</dt>
                        <dd>{s.isLive ? 'Active production connection' : 'Not connected in prototype'}</dd>
                      </dl>
                    </article>
                  ))}
                </div>
              </>
            )}

            {/* ALERTS & RULES SECTION */}
            {section === 'alerts' && (
              <>
                <div className={`${styles.notice} ${styles.noticeInfo}`}>
                  <div>
                    <b>Simulation only.</b> These controls simulate alert rules locally. No message is
                    sent to Teams or email.
                  </div>
                </div>

                <div className={styles.gridHalf}>
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <div>
                        <h2>Configure an example rule</h2>
                        <p>Thresholds require business-owner agreement</p>
                      </div>
                      <span className={`${styles.badge} ${styles.badgeGray}`}>LOCAL SIMULATION</span>
                    </div>
                    <div className={styles.cardbody}>
                      <form onSubmit={handleSimSubmit}>
                        <div className={styles.alertform}>
                          <div className={styles.field}>
                            <label htmlFor="alert-rule">Signal</label>
                            <select
                              id="alert-rule"
                              value={simRule}
                              onChange={(e) => {
                                const val = e.target.value as 'orders' | 'payments' | '5xx' | 'stale'
                                setSimRule(val)
                                setSimThreshold({ orders: 60, payments: 10, '5xx': 5, stale: 15 }[val])
                              }}
                            >
                              <option value="orders">No confirmed orders</option>
                              <option value="payments">Payment failure rate</option>
                              <option value="5xx">Origin 5xx rate</option>
                              <option value="stale">Data source stale</option>
                            </select>
                          </div>
                          <div className={styles.field}>
                            <label htmlFor="alert-threshold">Threshold (minutes or %)</label>
                            <input
                              id="alert-threshold"
                              type="number"
                              min="1"
                              max="240"
                              value={simThreshold}
                              onChange={(e) => setSimThreshold(Number(e.target.value))}
                              required
                            />
                          </div>
                          <div className={styles.field}>
                            <label htmlFor="alert-owner">Named owner</label>
                            <select
                              id="alert-owner"
                              value={simOwner}
                              onChange={(e) => setSimOwner(e.target.value)}
                            >
                              <option>Commerce operations</option>
                              <option>Payment integrations</option>
                              <option>DevOps on-call</option>
                            </select>
                          </div>
                          <div className={styles.field}>
                            <label htmlFor="alert-minimum">Minimum attempts / requests</label>
                            <input
                              id="alert-minimum"
                              type="number"
                              min="1"
                              max="100000"
                              value={simMinimum}
                              onChange={(e) => setSimMinimum(Number(e.target.value))}
                              required
                            />
                          </div>
                        </div>
                        <div className={styles.channelchecks}>
                          <label>
                            <input
                              type="checkbox"
                              checked={simTeams}
                              onChange={(e) => setSimTeams(e.target.checked)}
                            />
                            Teams · example
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={simEmail}
                              onChange={(e) => setSimEmail(e.target.checked)}
                            />
                            Email · example
                          </label>
                        </div>
                        <button type="submit" className={`${styles.btn} ${styles.btnDark}`}>
                          Run example evaluation
                        </button>
                      </form>

                      {simOutput && (
                        <div className={styles.simresult}>
                          <b>{simOutput.text}</b>
                          <p>{simOutput.subtext}</p>
                        </div>
                      )}
                    </div>
                  </article>

                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <h2>Proposed alert catalogue</h2>
                      <span className={`${styles.badge} ${styles.badgePending}`}>NOT ACTIVE</span>
                    </div>
                    <div className={styles.tablewrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>SIGNAL</th>
                            <th>SCOPE</th>
                            <th>OWNER</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>No orders / order drop</td>
                            <td>Brand + country</td>
                            <td>Commerce operations</td>
                          </tr>
                          <tr>
                            <td>Gateway failures</td>
                            <td>Gateway + method</td>
                            <td>Payment team</td>
                          </tr>
                          <tr>
                            <td>5xx / saturation</td>
                            <td>Host + environment</td>
                            <td>DevOps on-call</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </article>
                </div>
              </>
            )}

            <footer className={styles.sectionfoot}>
              <span>DESIGN PREVIEW · All displayed figures and examples are synthetic fixtures.</span>
              <span>Integration pending · Role-based access & redaction required before release.</span>
            </footer>
          </main>
        </div>
      </div>

      {/* Detail Overlay Drawer */}
      {activeError && (
        <div className={styles.overlay} onClick={() => setActiveError(null)}>
          <section className={styles.drawer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.drawerhead}>
              <div>
                <div className={styles.eyebrow}>SANITIZED SAMPLE · NOT A LIVE LOG</div>
                <h2>{errorDetails[activeError].title}</h2>
                <span className={`${styles.badge} ${styles.badgePending}`}>Drill-down concept</span>
              </div>
              <button
                type="button"
                className={styles.drawerclose}
                onClick={() => setActiveError(null)}
              >
                ×
              </button>
            </div>
            <div className={styles.drawerbody}>
              <div className={`${styles.notice} ${styles.noticeInfo}`}>
                <div>Safe sample only. This is synthetic demonstration context, not a live error.</div>
              </div>
              <dl>
                <dt>Service</dt>
                <dd>{errorDetails[activeError].service}</dd>
                <dt>HTTP status</dt>
                <dd>{errorDetails[activeError].status}</dd>
                <dt>Route</dt>
                <dd>{errorDetails[activeError].path}</dd>
                <dt>Trace ID</dt>
                <dd>demo-trace-0001 (synthetic)</dd>
              </dl>
              <h3>Interpretation</h3>
              <p>{errorDetails[activeError].note}</p>
              <h3>Redacted payload sample</h3>
              <pre>
                {JSON.stringify(
                  {
                    status: errorDetails[activeError].status,
                    code: errorDetails[activeError].code,
                    message: errorDetails[activeError].message,
                    headers: '[redacted]',
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </section>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && <div className={styles.toast}>{toastMessage}</div>}
    </div>
  )
}
