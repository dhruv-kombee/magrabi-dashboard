import ExcelJS from 'exceljs'
import type { BrandFilter, CountryFilter, SectionKey, TimezoneKey, TrafficSourceKey } from './types'
import { countries, offsets, formatTime, filterRecords, sum } from './fixtures'

export interface LiveDailyPoint {
  date: string
  orders: number
}

export interface LivePaymentBreakdown {
  fullCharge: number
  noneCharge: number
  onlineRate: number
  priorFullCharge?: number
  priorNoneCharge?: number
  priorOnlineRate?: number
  changePct?: number
}

export interface LiveOmsSummary {
  orders: number | null
  previousOrders: number | null
  changePct: number | null
  exceptions: number | null
}

export interface LiveSaleorSummary {
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

export interface ExportReportOptions {
  format: 'xlsx' | 'csv'
  section: SectionKey
  source: TrafficSourceKey
  brand: BrandFilter
  country: CountryFilter
  start: number
  end: number
  timezone: TimezoneKey
  liveSaleor: LiveSaleorSummary | null
  dailyPoints: [string, number][]
  currentWindowDays: number
  comparisonWindowLabel: string
  httpCodes: string[]
  httpCounts: number[]
  currentRecords: any[]
  fixtures: any[]
  sources: Record<string, any>
  filtered: boolean
  showToast: (msg: string) => void
}

// Styling Constants (Brand Green, Slate, Muted Accents)
const COLOR_BRAND_GREEN_DARK = 'FF0F4C33' // Deep Forest Green for Brand Header
const COLOR_BRAND_GREEN_SUB = 'FF165B3E'  // Medium Forest Green
const COLOR_HEADER_GREEN = 'FF0F5132'     // Magrabi Table Header Green
const COLOR_SECTION_BG = 'FF1E293B'       // Slate 900 for Section Titles
const COLOR_ZEBRA_EVEN = 'FFF8FAFC'       // Slate 50
const COLOR_ZEBRA_ODD = 'FFFFFFFF'        // Pure White
const COLOR_BORDER_LIGHT = 'FFE2E8F0'     // Slate 200
const COLOR_BORDER_HEADER = 'FF0D3A24'    // Dark green border
const COLOR_TEXT_MAIN = 'FF0F172A'        // Slate 900
const COLOR_TEXT_MUTED = 'FF64748B'       // Slate 500
const COLOR_GREEN_PILL_BG = 'FFDCFCE7'    // Emerald 100
const COLOR_GREEN_PILL_TXT = 'FF166534'   // Emerald 800
const COLOR_RED_PILL_BG = 'FFFEF2F2'      // Rose 50
const COLOR_RED_PILL_TXT = 'FFDC2626'     // Rose 600

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: COLOR_BORDER_LIGHT } },
  bottom: { style: 'thin', color: { argb: COLOR_BORDER_LIGHT } },
  left: { style: 'thin', color: { argb: COLOR_BORDER_LIGHT } },
  right: { style: 'thin', color: { argb: COLOR_BORDER_LIGHT } },
}

export async function exportReport(options: ExportReportOptions): Promise<void> {
  const {
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
  } = options

  const tzOffset = offsets[timezone] ?? 4
  const pad = (n: number) => String(n).padStart(2, '0')
  const nowZoned = new Date(Date.now() + tzOffset * 3600000)
  const exportDateStr = `${nowZoned.getUTCFullYear()}-${pad(nowZoned.getUTCMonth() + 1)}-${pad(nowZoned.getUTCDate())}`
  const exportTimeStr = `${pad(nowZoned.getUTCHours())}-${pad(nowZoned.getUTCMinutes())}`
  const windowStartStr = formatTime(start, timezone)
  const windowEndStr = formatTime(end, timezone)

  // -------------------------------------------------------------
  // BRANCH A: STYLED EXCEL WORKBOOK (.xlsx)
  // -------------------------------------------------------------
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Magrabi Commerce Intelligence'
    workbook.lastModifiedBy = 'Magrabi Commerce Intelligence'
    workbook.created = new Date()
    workbook.modified = new Date()
    workbook.properties.date1904 = false

    const sheetName =
      section === 'traffic'
        ? 'Traffic Report'
        : liveSaleor
        ? 'Live Operational Report'
        : 'Sample Report'

    const ws = workbook.addWorksheet(sheetName, {
      views: [{ showGridLines: true }],
      pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
    })

    // Setup standard column widths
    ws.columns = [
      { width: 28 }, // A
      { width: 24 }, // B
      { width: 22 }, // C
      { width: 22 }, // D
      { width: 44 }, // E
      { width: 18 }, // F
      { width: 18 }, // G
      { width: 20 }, // H
    ]

    // Helper: Style section banner
    const addSectionTitle = (title: string, endCol = 8) => {
      const emptyRow = ws.addRow([])
      emptyRow.height = 10

      const row = ws.addRow([title])
      row.height = 27
      const endColLetter = String.fromCharCode(64 + endCol)
      ws.mergeCells(`A${row.number}:${endColLetter}${row.number}`)
      const cell = ws.getCell(`A${row.number}`)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_SECTION_BG } }
      cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
      return row
    }

    // Helper: Style table column headers
    const addTableHeaders = (headers: string[]) => {
      const row = ws.addRow(headers)
      row.height = 24
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_GREEN } }
        cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'medium', color: { argb: COLOR_BORDER_HEADER } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      return row
    }

    // Helper: Style data rows with zebra striping
    const addStyledRow = (values: Array<string | number>, rowIndex: number) => {
      const row = ws.addRow(values)
      row.height = 21
      const isEven = rowIndex % 2 === 0
      const bgColor = isEven ? COLOR_ZEBRA_EVEN : COLOR_ZEBRA_ODD

      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }
        cell.font = { name: 'Segoe UI', size: 10, color: { argb: COLOR_TEXT_MAIN } }
        cell.border = thinBorder
        cell.alignment = { vertical: 'middle' }
      })
      return row
    }

    // --- BRAND BANNER ---
    const r1 = ws.addRow(['MAGRABI COMMERCE INTELLIGENCE PLATFORM'])
    r1.height = 36
    ws.mergeCells('A1:H1')
    const c1 = ws.getCell('A1')
    c1.font = { name: 'Segoe UI', size: 14, bold: true, color: { argb: 'FFFFFFFF' } }
    c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_BRAND_GREEN_DARK } }
    c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }

    const r2 = ws.addRow([
      liveSaleor
        ? 'OPERATIONAL EXECUTIVE REPORT · LIVE PRODUCTION TELEMETRY (SALEOR + MACULA OMS)'
        : 'COMMERCE INTELLIGENCE REPORT · SAMPLE / BENCHMARK FIXTURES',
    ])
    r2.height = 22
    ws.mergeCells('A2:H2')
    const c2 = ws.getCell('A2')
    c2.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FFD1FAE5' } }
    c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_BRAND_GREEN_SUB } }
    c2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }

    // --- METADATA SUMMARY CARD (Rows 4-7) ---
    ws.addRow([]) // blank line 3

    const metaItems: Array<[string, string, string, string]> = [
      ['Export Timestamp', `${exportDateStr} ${exportTimeStr.replace('-', ':')} (${timezone})`, 'Reporting Timezone', `${timezone} (UTC+${pad(tzOffset)}:00)`],
      ['Data Feed Status', liveSaleor ? '● LIVE PRODUCTION DATA' : 'SAMPLE FIXTURES DATA', 'Comparison Baseline', `vs ${comparisonWindowLabel}`],
      ['Filter Brand', brand === 'all' ? 'All Brands (Magrabi + DoctorM)' : brand, 'Filter Country', country === 'all' ? 'All Countries (SA, AE, EG, QA, KW)' : countries[country]?.name || country],
      ['Selected Window', `${windowStartStr} to ${windowEndStr}`, 'Window Duration', `${currentWindowDays} ${currentWindowDays === 1 ? 'day' : 'days'}`],
    ]

    metaItems.forEach(([k1, v1, k2, v2]) => {
      const row = ws.addRow([k1, v1, '', k2, v2])
      row.height = 20

      // Style Key 1
      const cellK1 = row.getCell(1)
      cellK1.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: COLOR_TEXT_MUTED } }
      cellK1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
      cellK1.border = thinBorder
      cellK1.alignment = { vertical: 'middle' }

      // Style Val 1
      const cellV1 = row.getCell(2)
      cellV1.font = { name: 'Segoe UI', size: 9.5, bold: k1 === 'Data Feed Status', color: { argb: k1 === 'Data Feed Status' && liveSaleor ? COLOR_GREEN_PILL_TXT : COLOR_TEXT_MAIN } }
      cellV1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: k1 === 'Data Feed Status' && liveSaleor ? COLOR_GREEN_PILL_BG : 'FFFFFFFF' } }
      cellV1.border = thinBorder
      cellV1.alignment = { vertical: 'middle' }

      // Style Key 2
      const cellK2 = row.getCell(4)
      cellK2.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: COLOR_TEXT_MUTED } }
      cellK2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
      cellK2.border = thinBorder
      cellK2.alignment = { vertical: 'middle' }

      // Style Val 2
      const cellV2 = row.getCell(5)
      cellV2.font = { name: 'Segoe UI', size: 9.5, color: { argb: COLOR_TEXT_MAIN } }
      cellV2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
      cellV2.border = thinBorder
      cellV2.alignment = { vertical: 'middle' }
    })

    let filename = `Magrabi_Commerce_Live_Report_${exportDateStr}_${exportTimeStr}_${timezone}.xlsx`

    // --- SECTIONS FOR LIVE DATA ---
    if (liveSaleor) {
      // 1. EXECUTIVE KPI SUMMARY
      addSectionTitle('1. EXECUTIVE KPI SUMMARY', 5)
      addTableHeaders(['KPI Metric', 'Current Window', 'Prior Comparison Window', 'Change %', 'Telemetry Notes'])

      const kpiData: Array<[string, number | string, number | string, number | string, string]> = [
        [
          'Orders placed (Saleor)',
          liveSaleor.orders,
          liveSaleor.previousOrders,
          `${liveSaleor.changePct > 0 ? '+' : ''}${liveSaleor.changePct.toFixed(1)}%`,
          'Authoritative live order creation in Saleor Core',
        ],
        [
          'Received in OMS (Macula)',
          liveSaleor.oms?.orders ?? '—',
          liveSaleor.oms?.previousOrders ?? '—',
          liveSaleor.oms?.changePct !== null && liveSaleor.oms?.changePct !== undefined ? `${liveSaleor.oms.changePct > 0 ? '+' : ''}${liveSaleor.oms.changePct.toFixed(1)}%` : '—',
          'Downstream receipt confirmed in Macula OMS search',
        ],
        [
          'Handoff Sync Exceptions',
          liveSaleor.oms?.exceptions ?? 'Unavailable',
          '—',
          '—',
          'Per-order reconciliation unavailable; a count difference does not prove a sync exception',
        ],
        [
          'Payment Success Rate',
          liveSaleor.paymentBreakdown ? `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}%` : '—',
          liveSaleor.paymentBreakdown?.priorOnlineRate !== undefined ? `${liveSaleor.paymentBreakdown.priorOnlineRate.toFixed(1)}%` : '—',
          liveSaleor.paymentBreakdown?.changePct !== undefined ? `${liveSaleor.paymentBreakdown.changePct > 0 ? '+' : ''}${liveSaleor.paymentBreakdown.changePct.toFixed(1)}%` : '—',
          'Online captured orders divided by total orders',
        ],
        [
          'Captured Online Orders',
          liveSaleor.paymentBreakdown?.fullCharge ?? 0,
          liveSaleor.paymentBreakdown?.priorFullCharge ?? '—',
          '—',
          'Saleor charge status: FULL',
        ],
        [
          'Uncharged / Cash Orders',
          liveSaleor.paymentBreakdown?.noneCharge ?? 0,
          liveSaleor.paymentBreakdown?.priorNoneCharge ?? '—',
          '—',
          'Saleor charge status: NONE / Cash on Delivery',
        ],
      ]

      kpiData.forEach(([metric, curr, prior, chg, note], idx) => {
        const row = addStyledRow([metric, curr, prior, chg, note], idx)
        row.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_TEXT_MAIN } }
        row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(2).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_TEXT_MAIN } }
        row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' }

        // Change % color badge
        const chgStr = String(chg)
        if (chgStr.startsWith('+')) {
          row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_GREEN_PILL_BG } }
          row.getCell(4).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_GREEN_PILL_TXT } }
        } else if (chgStr.startsWith('-')) {
          row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_RED_PILL_BG } }
          row.getCell(4).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_RED_PILL_TXT } }
        }

        row.getCell(5).font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: COLOR_TEXT_MUTED } }
      })

      // 2. DAILY ORDERS & OUTCOMES TREND
      addSectionTitle('2. DAILY ORDERS & OUTCOMES TREND', 8)
      addTableHeaders([
        'Date',
        'Day of Week',
        'Saleor Orders Placed',
        'OMS Received',
        'Online Captured (Daily)',
        'Cash / Uncharged (Daily)',
        'Daily Online Rate %',
        'Share of Total %',
      ])

      let sumPlaced = 0
      dailyPoints.forEach(([dStr, ords], idx) => {
        const captured = 'Unavailable'
        const cash = 'Unavailable'
        const oms = 'Unavailable'
        const ratePct = 'Unavailable'
        const sharePct = liveSaleor.orders > 0 ? ((ords / liveSaleor.orders) * 100).toFixed(1) + '%' : '0.0%'

        sumPlaced += ords

        let dayOfWeek = ''
        try {
          const parts = dStr.split('-').map(Number)
          if (parts.length === 3) {
            const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
            dayOfWeek = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
          }
        } catch {
          // ignore
        }

        const row = addStyledRow([dStr, dayOfWeek, ords, oms, captured, cash, ratePct, sharePct], idx)
        row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' }
      })

      // Total Row for Daily Trend
      const totRow = ws.addRow([
        'Total Window Summary',
        '',
        sumPlaced,
        liveSaleor.oms?.orders ?? 'Unavailable',
        liveSaleor.paymentBreakdown?.fullCharge ?? 'Unavailable',
        liveSaleor.paymentBreakdown?.noneCharge ?? 'Unavailable',
        liveSaleor.paymentBreakdown ? `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}% window total` : 'Unavailable',
        '100.0%',
      ])
      totRow.height = 23
      ws.mergeCells(`A${totRow.number}:B${totRow.number}`)
      totRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_TEXT_MAIN } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF94A3B8' } },
          bottom: { style: 'double', color: { argb: 'FF475569' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      totRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
      totRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' }
      totRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' }
      totRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' }
      totRow.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' }
      totRow.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' }
      totRow.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' }

      // 3. COUNTRY PERFORMANCE BREAKDOWN
      addSectionTitle('3. COUNTRY PERFORMANCE BREAKDOWN', 8)
      addTableHeaders([
        'Country Code',
        'Country Name',
        'Currency',
        'Orders Placed',
        'Prior Window Orders',
        'Trend %',
        'Volume Share %',
        'Payment Success Rate %',
      ])

      const countryRows = Object.entries(countries).filter(([c]) => country === 'all' || c === country)
      countryRows.forEach(([code, c], idx) => {
        const ordersCount = liveSaleor.countryBreakdown ? (liveSaleor.countryBreakdown[code] ?? 0) : 0
        const priorCount = liveSaleor.priorCountryBreakdown ? (liveSaleor.priorCountryBreakdown[code] ?? 0) : undefined
        let diffPct = '—'
        if (priorCount !== undefined && priorCount > 0) {
          const d = ((ordersCount - priorCount) / priorCount) * 100
          diffPct = `${d > 0 ? '+' : ''}${d.toFixed(1)}%`
        }
        const share = liveSaleor.orders > 0 ? ((ordersCount / liveSaleor.orders) * 100).toFixed(1) + '%' : '0%'
        const payRate = liveSaleor.paymentBreakdown ? `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}%` : '—'

        const row = addStyledRow([code, c.name, c.currency, ordersCount, priorCount ?? '—', diffPct, share, payRate], idx)
        row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_TEXT_MAIN } }
        row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(8).alignment = { vertical: 'middle', horizontal: 'center' }

        if (diffPct.startsWith('+')) {
          row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_GREEN_PILL_BG } }
          row.getCell(6).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_GREEN_PILL_TXT } }
        } else if (diffPct.startsWith('-')) {
          row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_RED_PILL_BG } }
          row.getCell(6).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_RED_PILL_TXT } }
        }
      })

      // 4. GROSS REVENUE BY CURRENCY
      addSectionTitle('4. GROSS REVENUE BY CURRENCY (NATIVE CURRENCY — NO BLENDING)', 6)
      addTableHeaders(['Currency', 'Country Code', 'Country Name', 'Gross Revenue Amount', 'Orders Count', 'Average Ticket (AOV)'])

      countryRows.forEach(([code, c], idx) => {
        const rev = liveSaleor.revenueByCurrency?.[c.currency] ?? 0
        const ords = liveSaleor.countryBreakdown?.[code] ?? 0
        const aov = ords > 0 ? Math.round(rev / ords) : 0

        const row = addStyledRow([c.currency, code, c.name, rev, ords, aov], idx)
        row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_TEXT_MAIN } }
        row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(4).numFmt = '#,##0.00'
        row.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(5).numFmt = '#,##0'
        row.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(6).numFmt = '#,##0.00'
      })

      // 5. PAYMENT GATEWAYS & METHODS
      addSectionTitle('5. PAYMENT GATEWAYS & METHODS (MACULA OMS)', 5)
      addTableHeaders(['Gateway / Method', 'Orders Processed', 'Category', 'Share %', 'Integration Status'])

      let gwIndex = 0
      const totalGw = Object.values(liveSaleor.gatewayCounts || {}).reduce((a, b) => a + b, 0) || 1
      Object.entries(liveSaleor.gatewayCounts || {}).forEach(([gw, count]) => {
        const share = ((count / totalGw) * 100).toFixed(1) + '%'
        const row = addStyledRow([gw, count, 'Payment Gateway', share, 'Active Production'], gwIndex++)
        row.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_TEXT_MAIN } }
        row.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_GREEN_PILL_BG } }
        row.getCell(5).font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: COLOR_GREEN_PILL_TXT } }
        row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' }
      })

      const totalM = Object.values(liveSaleor.methodCounts || {}).reduce((a, b) => a + b, 0) || 1
      Object.entries(liveSaleor.methodCounts || {}).forEach(([m, count]) => {
        const share = ((count / totalM) * 100).toFixed(1) + '%'
        const row = addStyledRow([m, count, 'Payment Method', share, 'Extracted from OMS Attributes'], gwIndex++)
        row.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: COLOR_TEXT_MAIN } }
        row.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' }
        row.getCell(5).font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: COLOR_TEXT_MUTED } }
        row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' }
      })
    } else if (section === 'traffic') {
      filename = `Magrabi_Traffic_${source}_${exportDateStr}_${exportTimeStr}_${timezone}.xlsx`
      const src = sources[source]
      const srcRows = filterRecords(fixtures, start, end, src.brand ? brand : 'all', src.country ? country : 'all')
      const factor = src.scale * (source === 'ingress' && filtered ? 0.79 : 1)
      const n = Math.round(sum(srcRows, 'requests') * factor)

      addSectionTitle('TRAFFIC & ERROR BREAKDOWN', 3)
      addTableHeaders(['HTTP Status Family', 'Request Count', 'Share of Source %'])

      httpCodes.forEach((code, i) => {
        const cnt = httpCounts[i] ?? 0
        const share = n > 0 ? ((cnt / n) * 100).toFixed(1) + '%' : '0%'
        const row = addStyledRow([`HTTP ${code}`, cnt, share], i)
        row.getCell(1).font = { name: 'Segoe UI', size: 10, bold: true }
        row.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' }
      })
    } else {
      filename = `Magrabi_Commerce_Orders_Sample_${exportDateStr}_${exportTimeStr}_${timezone}.xlsx`
      addSectionTitle('SAMPLE ORDERS DATA', 6)
      addTableHeaders(['Reporting Date', 'Brand', 'Country Code', 'Saleor Orders Placed', 'Currency', 'Gross Revenue'])

      const map = new Map<string, { day: string; brand: string; code: string; orders: number; revenue: number }>()
      for (const r of currentRecords) {
        const key = [formatTime(r.t, timezone).slice(0, 10), r.brand, r.code].join('|')
        if (!map.has(key)) {
          map.set(key, { day: formatTime(r.t, timezone).slice(0, 10), brand: r.brand, code: r.code, orders: 0, revenue: 0 })
        }
        const x = map.get(key)!
        x.orders += r.orders
        x.revenue += r.revenue
      }

      let idx = 0
      for (const x of map.values()) {
        const curr = countries[x.code]?.currency || 'AED'
        const row = addStyledRow([x.day, x.brand, x.code, x.orders, curr, x.revenue], idx++)
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' }
        row.getCell(6).numFmt = '#,##0.00'
      }
    }

    // Write binary buffer and trigger browser download
    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast(`Downloaded styled Excel report: ${filename}`)
    return
  }

  // -------------------------------------------------------------
  // BRANCH B: PLAIN TEXT CSV (.csv)
  // -------------------------------------------------------------
  let rows: Array<Array<string | number>> = []
  let filename = `Magrabi_Commerce_Orders_${exportDateStr}_${exportTimeStr}_${timezone}.csv`

  if (section === 'traffic') {
    const src = sources[source]
    filename = `Magrabi_Traffic_${source}_${exportDateStr}_${exportTimeStr}_${timezone}.csv`
    const srcRows = filterRecords(fixtures, start, end, src.brand ? brand : 'all', src.country ? country : 'all')
    const factor = src.scale * (source === 'ingress' && filtered ? 0.79 : 1)
    const n = Math.round(sum(srcRows, 'requests') * factor)
    rows = [
      ['MAGRABI COMMERCE INTELLIGENCE PLATFORM — TRAFFIC & ERROR REPORT'],
      ['Export Timestamp', `${exportDateStr} ${exportTimeStr.replace('-', ':')} (${timezone})`],
      ['Reporting Timezone', timezone],
      ['Traffic Source', src.name],
      ['Source Origin', src.origin],
      ['Window Start', windowStartStr],
      ['Window End', windowEndStr],
      ['Filter Brand', brand === 'all' ? 'All Brands' : brand],
      ['Filter Country', country === 'all' ? 'All Countries' : country],
      ['Total Requests Observed', n],
      [],
      ['HTTP Status Family', 'Request Count', 'Share of Source %'],
      ...httpCodes.map((code, i) => [
        `HTTP ${code}`,
        httpCounts[i] ?? 0,
        n > 0 ? (((httpCounts[i] ?? 0) / n) * 100).toFixed(1) + '%' : '0%',
      ]),
    ]
  } else if (liveSaleor) {
    filename = `Magrabi_Commerce_Live_Report_${exportDateStr}_${exportTimeStr}_${timezone}.csv`
    rows = [
      ['MAGRABI COMMERCE INTELLIGENCE PLATFORM — OPERATIONAL REPORT'],
      ['Export Timestamp', `${exportDateStr} ${exportTimeStr.replace('-', ':')} (${timezone})`],
      ['Data Feed Status', 'LIVE PRODUCTION DATA (Saleor GraphQL + Macula OMS)'],
      ['Reporting Timezone', `${timezone} (UTC+${pad(tzOffset)}:00)`],
      ['Filter Brand', brand === 'all' ? 'All Brands (Magrabi + DoctorM)' : brand],
      ['Filter Country', country === 'all' ? 'All Countries (SA, AE, EG, QA, KW)' : country],
      ['Selected Window', `${windowStartStr} to ${windowEndStr}`],
      ['Window Duration', `${currentWindowDays} ${currentWindowDays === 1 ? 'day' : 'days'}`],
      ['Comparison Baseline', `vs ${comparisonWindowLabel}`],
      [],
      ['1. EXECUTIVE KPI SUMMARY'],
      ['KPI Metric', 'Current Window', 'Prior Comparison Window', 'Change %', 'Telemetry Notes'],
      [
        'Orders placed (Saleor)',
        liveSaleor.orders,
        liveSaleor.previousOrders,
        `${liveSaleor.changePct > 0 ? '+' : ''}${liveSaleor.changePct.toFixed(1)}%`,
        'Authoritative live order creation in Saleor Core',
      ],
      [
        'Received in OMS (Macula)',
        liveSaleor.oms?.orders ?? '—',
        liveSaleor.oms?.previousOrders ?? '—',
        liveSaleor.oms?.changePct !== null && liveSaleor.oms?.changePct !== undefined ? `${liveSaleor.oms.changePct > 0 ? '+' : ''}${liveSaleor.oms.changePct.toFixed(1)}%` : '—',
        'Downstream receipt confirmed in Macula OMS search',
      ],
      [
        'Handoff Sync Exceptions',
        liveSaleor.oms?.exceptions ?? 'Unavailable',
        '—',
        '—',
        'Per-order reconciliation unavailable; a count difference does not prove a sync exception',
      ],
      [
        'Payment Success Rate',
        liveSaleor.paymentBreakdown ? `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}%` : '—',
        liveSaleor.paymentBreakdown?.priorOnlineRate !== undefined ? `${liveSaleor.paymentBreakdown.priorOnlineRate.toFixed(1)}%` : '—',
        liveSaleor.paymentBreakdown?.changePct !== undefined ? `${liveSaleor.paymentBreakdown.changePct > 0 ? '+' : ''}${liveSaleor.paymentBreakdown.changePct.toFixed(1)}%` : '—',
        'Online captured orders divided by total orders',
      ],
      [
        'Captured Online Orders',
        liveSaleor.paymentBreakdown?.fullCharge ?? 0,
        liveSaleor.paymentBreakdown?.priorFullCharge ?? '—',
        '—',
        'Saleor charge status: FULL',
      ],
      [
        'Uncharged / Cash Orders',
        liveSaleor.paymentBreakdown?.noneCharge ?? 0,
        liveSaleor.paymentBreakdown?.priorNoneCharge ?? '—',
        '—',
        'Saleor charge status: NONE / Cash on Delivery',
      ],
      [],
      ['2. DAILY ORDERS & OUTCOMES TREND'],
      ['Date', 'Day of Week', 'Saleor Orders Placed', 'OMS Received', 'Online Captured (Daily)', 'Cash / Uncharged (Daily)', 'Daily Online Rate %', 'Share of Total %'],
      ...dailyPoints.map(([dStr, ords]) => {
        const sharePct = liveSaleor.orders > 0 ? ((ords / liveSaleor.orders) * 100).toFixed(1) + '%' : '0.0%'
        let dayOfWeek = ''
        try {
          const parts = dStr.split('-').map(Number)
          if (parts.length === 3) {
            const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
            dayOfWeek = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
          }
        } catch {
          // ignore
        }
        return [
          dStr,
          dayOfWeek,
          ords,
          'Unavailable',
          'Unavailable',
          'Unavailable',
          'Unavailable',
          sharePct,
        ]
      }),
      [],
      ['3. COUNTRY PERFORMANCE BREAKDOWN'],
      ['Country Code', 'Country Name', 'Currency', 'Orders Placed', 'Prior Window Orders', 'Trend %', 'Volume Share %', 'Payment Success Rate %'],
      ...Object.entries(countries)
        .filter(([c]) => country === 'all' || c === country)
        .map(([code, c]) => {
          const ordersCount = liveSaleor.countryBreakdown ? (liveSaleor.countryBreakdown[code] ?? 0) : 0
          const priorCount = liveSaleor.priorCountryBreakdown ? (liveSaleor.priorCountryBreakdown[code] ?? 0) : undefined
          let diffPct = '—'
          if (priorCount !== undefined && priorCount > 0) {
            const d = ((ordersCount - priorCount) / priorCount) * 100
            diffPct = `${d > 0 ? '+' : ''}${d.toFixed(1)}%`
          }
          const share = liveSaleor.orders > 0 ? ((ordersCount / liveSaleor.orders) * 100).toFixed(1) + '%' : '0%'
          const payRate = liveSaleor.paymentBreakdown ? `${liveSaleor.paymentBreakdown.onlineRate.toFixed(1)}%` : '—'
          return [code, c.name, c.currency, ordersCount, priorCount ?? '—', diffPct, share, payRate]
        }),
      [],
      ['4. GROSS REVENUE BY CURRENCY (NATIVE CURRENCY — NO BLENDING)'],
      ['Currency', 'Country Code', 'Currency Name', 'Gross Revenue Amount', 'Orders Count', 'Average Ticket (AOV)'],
      ...Object.entries(countries)
        .filter(([code]) => country === 'all' || code === country)
        .map(([code, c]) => {
          const rev = liveSaleor.revenueByCurrency?.[c.currency] ?? 0
          const ords = liveSaleor.countryBreakdown?.[code] ?? 0
          const aov = ords > 0 ? Math.round(rev / ords) : 0
          return [c.currency, code, c.name, rev.toFixed(2), ords, aov.toFixed(2)]
        }),
      [],
      ['5. PAYMENT GATEWAYS & METHODS (MACULA OMS)'],
      ['Gateway / Method', 'Orders Processed', 'Category', 'Share %', 'Integration Status'],
      ...Object.entries(liveSaleor.gatewayCounts || {}).map(([gw, count]) => {
        const totalGw = Object.values(liveSaleor.gatewayCounts || {}).reduce((a, b) => a + b, 0) || 1
        const share = ((count / totalGw) * 100).toFixed(1) + '%'
        return [gw, count, 'Payment Gateway', share, 'Active Production']
      }),
      ...Object.entries(liveSaleor.methodCounts || {}).map(([m, count]) => {
        const totalM = Object.values(liveSaleor.methodCounts || {}).reduce((a, b) => a + b, 0) || 1
        const share = ((count / totalM) * 100).toFixed(1) + '%'
        return [m, count, 'Payment Method', share, 'Extracted from OMS Attributes']
      }),
    ]
  } else {
    filename = `Magrabi_Commerce_Orders_Sample_${exportDateStr}_${exportTimeStr}_${timezone}.csv`
    const map = new Map<string, { day: string; brand: string; code: string; orders: number; revenue: number }>()
    for (const r of currentRecords) {
      const key = [formatTime(r.t, timezone).slice(0, 10), r.brand, r.code].join('|')
      if (!map.has(key)) {
        map.set(key, { day: formatTime(r.t, timezone).slice(0, 10), brand: r.brand, code: r.code, orders: 0, revenue: 0 })
      }
      const x = map.get(key)!
      x.orders += r.orders
      x.revenue += r.revenue
    }
    rows = [
      ['MAGRABI COMMERCE INTELLIGENCE PLATFORM — REPORT'],
      ['Export Timestamp', `${exportDateStr} ${exportTimeStr.replace('-', ':')} (${timezone})`],
      ['Reporting Timezone', timezone],
      ['Window Start', windowStartStr],
      ['Window End', windowEndStr],
      [],
      ['Reporting Date', 'Brand', 'Country Code', 'Saleor Orders Placed', 'Currency', 'Gross Revenue'],
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
    rows
      .map((r) =>
        r.length === 0
          ? ''
          : r
              .map((v) => {
                let s = String(v ?? '')
                // Prevent Excel formula injection warnings
                if (s.startsWith('=') || s.startsWith('+') || s.startsWith('@')) {
                  s = ' ' + s
                }
                return `"${s.replaceAll('"', '""')}"`
              })
              .join(','),
      )
      .join('\r\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  showToast(`Exported ${filename}`)
}
