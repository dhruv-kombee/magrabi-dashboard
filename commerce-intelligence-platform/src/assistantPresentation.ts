import type { AssistantMessage, AssistantScope } from './assistantHistory'

export interface PresentationRow {
  metric: string
  value: string
  source: string
}

export interface AssistantPresentation {
  title: string
  subtitle: string
  highlights: PresentationRow[]
  rows: PresentationRow[]
  note: string
}

const titles: Record<string, string> = {
  sales: 'Macula orders & Saleor value',
  oms_orders: 'Macula OMS received orders',
  reconciliation: 'Saleor vs Macula order stages',
  revenue: 'Revenue by currency',
  orders: 'Order performance',
  payments: 'Payment status',
  traffic: 'Traffic and errors',
  infrastructure: 'Infrastructure status',
  sources: 'Connector status',
}
const countryNames: Record<string, string> = {
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', EG: 'Egypt', QA: 'Qatar', KW: 'Kuwait',
}

const notes: Record<string, string> = {
  sales: 'Macula received orders are the primary count. Saleor placed orders and gross placed-order value are separate facts, not OMS-received revenue. Live snapshots may change between refreshes.',
  revenue: 'Gross order value is shown in each original currency. No exchange conversion or cross-currency total is applied.',
  orders: 'Saleor placed orders and Macula OMS received orders are separate stages. A count difference is not a confirmed per-order sync exception.',
  oms_orders: 'This is the verified Macula OMS receipt count only. It is not a Saleor placed-order count.',
  reconciliation: 'A difference between placed and received counts is not proof of a failed handoff. Matching order IDs and timestamps is required.',
  payments: 'Saleor charge status is not a gateway authorization success rate. Macula gateway attribution, when shown, is sampled.',
  traffic: 'Connector status is not a measured request or error rate.',
  infrastructure: 'Connector health is not a measured latency or capacity value.',
}

function windowLabel(scope?: AssistantScope) {
  if (!scope) return 'Selected platform scope'
  const timezone = { Dubai: 'Asia/Dubai', UTC: 'UTC', IST: 'Asia/Kolkata' }[scope.tz] || 'UTC'
  const format = (value: number | null) => value === null ? '' : new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone,
  }).format(new Date(value))
  const start = format(scope.start)
  const end = format(scope.end)
  const period = start && end ? start === end ? start : `${start} – ${end}` : 'Selected period'
  const country = scope.country === 'all' ? 'All countries' : countryNames[scope.country] || scope.country
  const brand = scope.brand === 'all' ? 'All brands' : scope.brand
  return `${period} · ${brand} · ${country}`
}

export function buildAssistantPresentation(message: AssistantMessage): AssistantPresentation | null {
  if (message.role !== 'assistant' || !message.question || !message.evidence?.length) return null
  const rows: PresentationRow[] = message.evidence.flatMap((source) => source.facts.map((fact) => {
    const currency = fact.label.match(/^([A-Z]{3}) gross (?:placed-order )?value$/)
    return {
      metric: fact.label,
      value: currency && fact.value !== 'unavailable' ? `${currency[1]} ${fact.value}` : fact.value,
      source: source.name,
    }
  }))
  if (!rows.length) return null

  const labels = rows.map((row) => row.metric.toLowerCase())
  const intent = message.intent || (
    labels.some((label) => label.includes('gross value') || label.includes('gross placed-order value'))
      ? labels.some((label) => label === 'orders' || label === 'placed orders' || label === 'received orders') ? 'sales' : 'revenue'
      : labels.some((label) => label.includes('charged')) ? 'payments' : 'orders'
  )
  const useful = rows.filter((row) => row.value && !/^(?:unavailable|none verified)$/i.test(row.value) && !/not mapped|not queried/i.test(row.value))
  const highlighted = ['sales', 'revenue', 'orders', 'oms_orders', 'reconciliation', 'payments'].includes(intent) ? useful.slice(0, 3) : []
  const legacySaleorOnly = intent === 'sales' && !message.evidence.some((source) => source.name === 'Macula OMS')
  return {
    title: legacySaleorOnly ? 'Saleor placed sales snapshot' : titles[intent] || 'Verified platform data',
    subtitle: windowLabel(message.scope),
    highlights: highlighted,
    rows,
    note: legacySaleorOnly ? 'Saved Saleor-only answer. Macula OMS receipts were not verified in this snapshot; ask again for the current source-separated view.' : notes[intent] || 'Values are shown as supplied by the named platform source.',
  }
}
