import React, { useState, useMemo } from 'react'
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
  fixtureEnd,
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
    status: 'Business source identified',
    scope:
      'Orders received by OMS, fulfilment state and handoff exceptions — not a substitute for Saleor orders placed.',
    need: 'Supported reporting API/view or events; reconcile canonical order IDs and never sum the two system counts.',
    owner: 'OMS + backend owners',
    badgeText: 'Order feed pending',
  },
  {
    name: 'Saleor / placed orders + payments',
    status: 'Business source identified',
    scope:
      'Authoritative order creation and checkout/payment events. OMS delivery is measured separately.',
    need: 'Read-only reporting contract, order/attempt IDs, deduplication and OMS handoff reconciliation.',
    owner: 'Saleor + backend owners',
    badgeText: 'Connector pending',
  },
  {
    name: 'Payment gateways',
    status: 'Provider sources identified',
    scope: 'Attempt outcomes, pending callbacks, methods and settlement state.',
    need: 'Provider-approved API/webhook events, gateway-specific success meanings and retry handling.',
    owner: 'Payment integration owners',
    badgeText: 'Connector pending',
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

export function CommerceDashboard() {
  const [section, setSection] = useState<SectionKey>('overview')
  const [brand, setBrand] = useState<BrandFilter>('all')
  const [country, setCountry] = useState<CountryFilter>('all')
  const [start, setStart] = useState<number>(Date.parse('2026-10-07T20:00:00Z'))
  const [end, setEnd] = useState<number>(Date.parse('2026-10-14T20:00:00Z'))
  const [timezone, setTimezone] = useState<TimezoneKey>('Dubai')
  const [source, setSource] = useState<TrafficSourceKey>('frontdoor')
  const [filtered, setFiltered] = useState(false)

  // Filter form draft states
  const [formStart, setFormStart] = useState('2026-10-08T00:00')
  const [formEnd, setFormEnd] = useState('2026-10-15T00:00')
  const [formBrand, setFormBrand] = useState<BrandFilter>('all')
  const [formCountry, setFormCountry] = useState<CountryFilter>('all')
  const [formTz, setFormTz] = useState<TimezoneKey>('Dubai')
  const [filterError, setFilterError] = useState('')

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

  // Current Records
  const currentRecords = useMemo(
    () => filterRecords(fixtures, start, end, brand, country),
    [start, end, brand, country],
  )
  const currentAgg = useMemo(() => aggregate(currentRecords), [currentRecords])

  // Prior Window Records (for baseline delta)
  const priorAgg = useMemo(() => {
    const duration = end - start
    if (start - duration < fixtureStart) return null
    return aggregate(filterRecords(fixtures, start - duration, start, brand, country))
  }, [start, end, brand, country])

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
    if (s < fixtureStart || eTime > fixtureEnd) {
      setFilterError(
        'This demonstration contains fixtures from 01 Sep 2026 to 15 Oct 2026 UTC. Choose a range inside those bounds.',
      )
      return
    }
    if (eTime - s > 31 * 86400000) {
      setFilterError('Choose up to 31 days for this demonstration.')
      return
    }

    setFilterError('')
    setStart(s)
    setEnd(eTime)
    setBrand(formBrand)
    setCountry(formCountry)
    setTimezone(formTz)
    showToast('Filters applied to synthetic fixtures. No live source was queried.')
  }

  const handleFilterReset = () => {
    setFormBrand('all')
    setFormCountry('all')
    setFormTz('Dubai')
    setFormStart('2026-10-08T00:00')
    setFormEnd('2026-10-15T00:00')
    setFilterError('')
    setStart(Date.parse('2026-10-07T20:00:00Z'))
    setEnd(Date.parse('2026-10-14T20:00:00Z'))
    setBrand('all')
    setCountry('all')
    setTimezone('Dubai')
    showToast('Filters reset to default 7-day window.')
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

  const exportCSV = () => {
    let rows: Array<Array<string | number>> = []
    let filename = 'DEMO-commerce-orders.csv'

    if (section === 'traffic') {
      const src = sources[source]
      const srcRows = filterRecords(
        fixtures,
        start,
        end,
        src.brand ? brand : 'all',
        src.country ? country : 'all',
      )
      const factor = src.scale * (source === 'ingress' && filtered ? 0.79 : 1)
      const n = Math.round(sum(srcRows, 'requests') * factor)
      rows = [
        ['DEMO ONLY — synthetic fixture export — not production data'],
        ['Source', src.name],
        ['Window start UTC', new Date(start).toISOString()],
        ['Window end UTC exclusive', new Date(end).toISOString()],
        ['Reporting timezone', timezone],
        ['Total Sample Requests', n],
      ]
      filename = `DEMO-traffic-${source}.csv`
    } else {
      const map = new Map<string, { day: string; brand: string; code: string; orders: number; revenue: number }>()
      for (const r of currentRecords) {
        const key = [dayKey(r.t, timezone), r.brand, r.code].join('|')
        if (!map.has(key)) {
          map.set(key, { day: dayKey(r.t, timezone), brand: r.brand, code: r.code, orders: 0, revenue: 0 })
        }
        const x = map.get(key)!
        x.orders += r.orders
        x.revenue += r.revenue
      }
      rows = [
        ['DEMO ONLY — synthetic fixture export — not production data'],
        ['Reporting timezone', timezone],
        ['Window start UTC', new Date(start).toISOString()],
        ['Window end UTC exclusive', new Date(end).toISOString()],
        ['Reporting date', 'Brand', 'Order country', 'Sample Saleor orders placed', 'Currency', 'Sample gross revenue'],
        ...[...map.values()].map((x) => [
          x.day,
          x.brand,
          x.code,
          x.orders,
          countries[x.code]?.currency || 'AED',
          x.revenue,
        ]),
      ]
    }

    const csvContent =
      '\uFEFF' +
      rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast('Exported sample CSV data.')
  }

  // Delta calculation helper
  const renderDelta = (currentVal: number, priorVal?: number) => {
    if (priorVal === undefined || priorVal === null || priorVal === 0) {
      return <span className={styles.tiny}>Baseline not available</span>
    }
    const diff = ((currentVal - priorVal) / priorVal) * 100
    return (
      <>
        <span className={`${styles.change} ${diff < 0 ? styles.changeDown : ''}`}>
          {diff > 0 ? '+' : ''}
          {diff.toFixed(1)}%
        </span>
        <span>vs previous equal window</span>
      </>
    )
  }

  // Daily orders chart data
  const dailyPoints = useMemo(() => {
    const out = new Map<string, number>()
    for (const r of currentRecords) {
      const day = dayKey(r.t, timezone)
      out.set(day, (out.get(day) || 0) + r.orders)
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [currentRecords, timezone])

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

  // Payment Outcomes ring calculation
  const paymentRate = currentAgg.attempts ? currentAgg.success / currentAgg.attempts : 0
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
              <span className={`${styles.badge} ${styles.badgeDemo}`}>
                <span className={styles.dot}></span> DEMO · SAMPLE DATA · NOT LIVE
              </span>
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
                <button type="button" className={styles.btn} onClick={exportCSV}>
                  Export sample CSV
                </button>
              </div>
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
              <div>
                <label htmlFor="start">From · inclusive</label>
                <input
                  type="datetime-local"
                  id="start"
                  value={formStart}
                  onChange={(e) => setFormStart(e.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="end">To · exclusive</label>
                <input
                  type="datetime-local"
                  id="end"
                  value={formEnd}
                  onChange={(e) => setFormEnd(e.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="timezone">Reporting timezone</label>
                <select
                  id="timezone"
                  value={formTz}
                  onChange={(e) => setFormTz(e.target.value as TimezoneKey)}
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
                Fixed fixtures: 01 Sep–14 Oct 2026 UTC · <strong>No live refresh</strong>
              </span>
            </div>

            {filterError && <div className={styles.noresult}>{filterError}</div>}

            {/* OVERVIEW SECTION */}
            {section === 'overview' && (
              <>
                <div className={styles.metrics}>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Orders placed · Saleor</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.orders)}</div>
                    <div className={styles.metricfoot}>
                      {renderDelta(currentAgg.orders, priorAgg?.orders)}
                    </div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Payment success</div>
                    <div className={styles.metricvalue}>{pct(currentAgg.success, currentAgg.attempts)}</div>
                    <div className={styles.metricfoot}>Online attempts · cash excluded</div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Journey conversion</div>
                    <div className={styles.metricvalue}>
                      {pct(currentAgg.orders, currentAgg.steps[0])}
                    </div>
                    <div className={styles.metricfoot}>Demo confirmed / add-to-cart cohort</div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Received in OMS</div>
                    <div className={styles.metricvalue}>
                      {fmt(currentAgg.orders - Math.floor(currentAgg.orders * 0.02))}
                    </div>
                    <div className={styles.metricfoot}>
                      {fmt(Math.floor(currentAgg.orders * 0.02))} sample handoff exceptions · reconcile IDs
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
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    </div>
                    <div className={styles.cardbody} style={{ paddingBottom: '7px' }}>
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
                            {dailyPoints.map((p, i) => (
                              <circle
                                key={p[0]}
                                cx={getX(i)}
                                cy={getY(p[1])}
                                r="3.5"
                                fill="white"
                                stroke="#507b5b"
                                strokeWidth="2"
                              >
                                <title>{`${p[0]}: ${fmt(p[1])} orders`}</title>
                              </circle>
                            ))}
                          </>
                        )}
                      </svg>
                    </div>
                    <div className={styles.chartfooter}>
                      <div className={styles.legend}>
                        <span><i></i>Orders placed</span>
                      </div>
                      <span>Reporting days in {timezone} · hover points for values</span>
                    </div>
                  </article>

                  {/* Payment Ring Card */}
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <div>
                        <h2>Payment outcomes</h2>
                        <p>Distinct online attempts · illustrative mapping</p>
                      </div>
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    </div>
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
                            <b>{pct(currentAgg.success, currentAgg.attempts)}</b>
                            <span>confirmed success</span>
                          </div>
                        </div>
                        <div className={styles.ringlegend}>
                          <div>
                            <span className={styles.dot} style={{ color: '#5a8263' }}></span>
                            Success <b>{fmt(currentAgg.success)}</b>
                          </div>
                          <div>
                            <span className={styles.dot} style={{ color: '#d6978a' }}></span>
                            Failed <b>{fmt(currentAgg.failed)}</b>
                          </div>
                          <div>
                            <span className={styles.dot} style={{ color: '#d6dccc' }}></span>
                            Pending <b>{fmt(currentAgg.pending)}</b>
                          </div>
                        </div>
                      </div>
                      <div className={styles.ruleline}></div>
                      <div className={styles.minirow}>
                        <span>Online payment attempts</span>
                        <strong>{fmt(currentAgg.attempts)}</strong>
                      </div>
                      <div className={styles.minirow}>
                        <span>Cash orders · excluded from rate</span>
                        <strong>{fmt(currentAgg.cash)}</strong>
                      </div>
                      <p className={styles.tiny} style={{ lineHeight: '1.6' }}>
                        Success means a confirmed gateway outcome, not HTTP 200.
                      </p>
                    </div>
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
                  <article className={styles.card}>
                    <div className={styles.cardhead} style={{ paddingBottom: '17px' }}>
                      <div>
                        <h2>Country performance</h2>
                        <p>Country from order/channel data · never inferred from IP</p>
                      </div>
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    </div>
                    <div className={styles.tablewrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>COUNTRY</th>
                            <th className={styles.num}>ORDERS</th>
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
                              const sharePct = currentAgg.orders
                                ? (x.orders / currentAgg.orders) * 100
                                : 0
                              return (
                                <tr key={code}>
                                  <td>
                                    <span className={styles.countryflag}>{code}</span>
                                    {c.name}
                                  </td>
                                  <td className={styles.num}><b>{fmt(x.orders)}</b></td>
                                  <td className={styles.num}>
                                    <span className={styles.inlinebar}>
                                      <i style={{ width: `${sharePct}%` }}></i>
                                    </span>
                                    {pct(x.orders, currentAgg.orders)}
                                  </td>
                                  <td className={styles.num}>{pct(x.success, x.attempts)}</td>
                                </tr>
                              )
                            })}
                        </tbody>
                      </table>
                    </div>
                    <div className={styles.chartfooter}>
                      Business-country filters require validated brand/channel mappings.
                    </div>
                  </article>

                  {/* Mini Funnel Card */}
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <div>
                        <h2>Customer journey</h2>
                        <p>Seven steps · new instrumentation required</p>
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
                          return (
                            <div key={i} className={styles.funnelcol}>
                              <b>{fmt(n)}</b>
                              <div
                                className={styles.funnelbar}
                                style={{ height: `${Math.max(8, (n / maxStep) * 95)}px` }}
                              ></div>
                              <span>{labels[i]}</span>
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
                      <p>Illustrative gross order value · no FX conversion or cross-currency total</p>
                    </div>
                    <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                  </div>
                  <div className={styles.cardbody}>
                    <div className={styles.amounts}>
                      {Object.entries(countries)
                        .filter(([c]) => country === 'all' || c === country)
                        .map(([code, c]) => {
                          const rev = Math.round(
                            sum(
                              currentRecords.filter((r) => r.code === code),
                              'revenue',
                            ),
                          )
                          return (
                            <span key={code}>
                              {c.currency}
                              <b>{fmt(rev)}</b>
                            </span>
                          )
                        })}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ORDERS & PAYMENTS SECTION */}
            {section === 'orders' && (
              <>
                <div className={styles.metrics}>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Confirmed orders</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.orders)}</div>
                    <div className={styles.metricfoot}>
                      {renderDelta(currentAgg.orders, priorAgg?.orders)}
                    </div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Online attempts</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.attempts)}</div>
                    <div className={styles.metricfoot}>Retry-deduplicated event concept</div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Payment successes</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.success)}</div>
                    <div className={styles.metricfoot}>Gateway confirmed · demo outcomes</div>
                  </div>
                  <div className={`${styles.card} ${styles.metric}`}>
                    <div className={styles.metriclabel}>Cash orders</div>
                    <div className={styles.metricvalue}>{fmt(currentAgg.cash)}</div>
                    <div className={styles.metricfoot}>Not an online authorization metric</div>
                  </div>
                </div>

                <article className={`${styles.card} ${styles.spacer}`}>
                  <div className={styles.cardhead} style={{ paddingBottom: '18px' }}>
                    <div>
                      <h2>Payment gateway performance</h2>
                      <p>Success + failed + pending = attempts</p>
                    </div>
                    <span className={`${styles.badge} ${styles.badgePending}`}>INTEGRATION PENDING</span>
                  </div>
                  <div className={styles.tablewrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>GATEWAY</th>
                          <th className={styles.num}>ATTEMPTS</th>
                          <th className={styles.num}>SUCCESS</th>
                          <th className={styles.num}>FAILED</th>
                          <th className={styles.num}>PENDING</th>
                          <th className={styles.num}>SUCCESS RATE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {['Checkout.com', 'Tabby', 'Tamara', 'Paymob'].map((gw, i) => {
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
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>

                <div className={styles.gridHalf}>
                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <h2>Payment method-wise orders</h2>
                      <span className={`${styles.badge} ${styles.badgeGray}`}>SAMPLE</span>
                    </div>
                    <div className={styles.cardbody}>
                      {['Card', 'Apple Pay', 'KNET', 'Tabby', 'Tamara', 'Cash'].map((m, i) => {
                        const onlineNums = split(currentAgg.orders - currentAgg.cash, [37, 23, 10, 15, 15])
                        const val = i === 5 ? currentAgg.cash : onlineNums[i]
                        return (
                          <div key={m} className={styles.minirow}>
                            <span>{m}</span>
                            <b>{fmt(val)}</b>
                          </div>
                        )
                      })}
                      <div className={styles.definition}>
                        Apple Pay and KNET are methods; Checkout.com and Paymob are gateways.
                      </div>
                    </div>
                  </article>

                  <article className={styles.card}>
                    <div className={styles.cardhead}>
                      <h2>Revenue & comparison rules</h2>
                    </div>
                    <div className={styles.cardbody}>
                      <div className={styles.amounts}>
                        {Object.entries(countries)
                          .filter(([c]) => country === 'all' || c === country)
                          .map(([code, c]) => (
                            <span key={code}>
                              {c.currency}
                              <b>
                                {fmt(
                                  Math.round(
                                    sum(
                                      currentRecords.filter((r) => r.code === code),
                                      'revenue',
                                    ),
                                  ),
                                )}
                              </b>
                            </span>
                          ))}
                      </div>
                      <div className={styles.definition} style={{ marginTop: '15px' }}>
                        No mixed-currency sum. Production definitions must agree gross/net,
                        cancellations, refunds, and order states.
                      </div>
                    </div>
                  </article>
                </div>
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
                    <b>Connection status is intentionally honest.</b> Sources are identified from the
                    existing estate, but this dashboard connects to none of them yet. Every integration
                    is pending approval.
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
                        <span className={`${styles.badge} ${styles.badgePending}`}>{s.badgeText}</span>
                      </div>
                      <p>{s.scope}</p>
                      <dl>
                        <dt>Required next</dt>
                        <dd>{s.need}</dd>
                        <dt>Owner</dt>
                        <dd>{s.owner}</dd>
                        <dt>Connection</dt>
                        <dd>Not connected in prototype</dd>
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
