import type { AggregatedData, CountryInfo, FixtureRecord, TimezoneKey, TrafficSourceKey } from './types'

export const countries: Record<string, CountryInfo> = {
  AE: { name: 'United Arab Emirates', currency: 'AED', weight: 1.5 },
  SA: { name: 'Saudi Arabia', currency: 'SAR', weight: 1.85 },
  EG: { name: 'Egypt', currency: 'EGP', weight: 0.75 },
  QA: { name: 'Qatar', currency: 'QAR', weight: 0.5 },
  KW: { name: 'Kuwait', currency: 'KWD', weight: 0.45 },
}

export const offsets: Record<TimezoneKey, number> = {
  UTC: 0,
  Dubai: 4,
  IST: 5.5,
}

export const fixtureStart = Date.parse('2026-09-01T00:00:00Z')
export const fixtureEnd = Date.parse('2026-10-15T00:00:00Z')

const hash = (n: number) => {
  const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return v - Math.floor(v)
}

export const fixtures: FixtureRecord[] = []

for (let t = fixtureStart; t < fixtureEnd; t += 3600000) {
  const d = new Date(t)
  const hour = (d.getUTCHours() + 4) % 24
  for (const [ci, code] of Object.keys(countries).entries()) {
    for (const [bi, brand] of ['Magrabi', 'DoctorM'].entries()) {
      const seed = Math.floor(t / 3600000) + ci * 31 + bi * 127
      const peak = hour < 8 ? 0.2 : hour < 15 ? 0.78 : 1.2
      const w = countries[code].weight * (bi ? 0.29 : 1)
      const orders = Math.floor(hash(seed) * 3.8 * w * peak) + (hash(seed + 82) > 0.94 ? 1 : 0)
      const cash = Math.floor(orders * (code === 'EG' ? 0.4 : 0.12))
      const success = orders - cash
      const failed = Math.floor(hash(seed + 8) * 2.5 * w * peak)
      const pending = hash(seed + 13) > 0.82 ? 1 : 0
      const attempts = success + failed + pending
      const confirmed = orders
      const place = orders + failed + pending
      const details = place + Math.floor(hash(seed + 12) * 3 * w)
      const shipping = details + Math.floor(hash(seed + 14) * 4 * w)
      const proceed = shipping + Math.floor(hash(seed + 32) * 4 * w)
      const cart = proceed + Math.floor(hash(seed + 22) * 9 * w)
      const add = cart + Math.floor(hash(seed + 44) * 11 * w)
      const revenue =
        orders * (code === 'KW' ? 49 : code === 'EG' ? 2800 : 630) +
        Math.round(hash(seed + 101) * orders * 80)
      fixtures.push({
        t,
        code,
        brand,
        orders,
        cash,
        success,
        failed,
        pending,
        attempts,
        revenue,
        steps: [add, cart, proceed, shipping, details, place, confirmed],
        requests: Math.round((55 + hash(seed + 7) * 360) * w * peak),
      })
    }
  }
}

export function filterRecords(
  allFixtures: FixtureRecord[],
  start: number,
  end: number,
  brand: string,
  country: string,
): FixtureRecord[] {
  return allFixtures.filter(
    (r) =>
      r.t >= start &&
      r.t < end &&
      (brand === 'all' || r.brand === brand) &&
      (country === 'all' || r.code === country),
  )
}

export function sum<K extends keyof FixtureRecord>(rows: FixtureRecord[], key: K): number {
  return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0)
}

export function aggregate(rows: FixtureRecord[]): AggregatedData {
  return {
    rows,
    orders: sum(rows, 'orders'),
    attempts: sum(rows, 'attempts'),
    success: sum(rows, 'success'),
    failed: sum(rows, 'failed'),
    pending: sum(rows, 'pending'),
    cash: sum(rows, 'cash'),
    requests: sum(rows, 'requests'),
    steps: Array.from({ length: 7 }, (_, i) => rows.reduce((a, r) => a + r.steps[i], 0)),
  }
}

export const fmt = (n: number) => Number(n).toLocaleString('en-US')

export const pct = (a: number, b: number) =>
  b ? ((a / b) * 100).toFixed(1) + '%' : 'Not available'

export function dayKey(t: number, tz: TimezoneKey): string {
  return new Date(t + offsets[tz] * 3600000).toISOString().slice(0, 10)
}

export function formatTime(t: number, tz: TimezoneKey): string {
  return new Date(t + offsets[tz] * 3600000).toISOString().slice(0, 16).replace('T', ' ')
}

export function split(n: number, weights: number[]): number[] {
  const sumWeights = weights.reduce((a, b) => a + b, 0)
  const vals = weights.map((w) => Math.floor((n * w) / sumWeights))
  let left = n - vals.reduce((a, b) => a + b, 0)
  for (let i = 0; left > 0; i++, left--) {
    vals[i % vals.length]++
  }
  return vals
}

export interface TrafficSourceMeta {
  name: string
  origin: string
  brand: boolean
  country: boolean
  scale: number
  coverage: string
  note: string
}

export const sources: Record<TrafficSourceKey, TrafficSourceMeta> = {
  frontdoor: {
    name: 'Main Front Door',
    origin: 'Azure platform RequestCount',
    brand: false,
    country: false,
    scale: 12.5,
    coverage: 'Platform metric concept; hostname separation must be verified.',
    note: 'Global brand and order-country filters do not apply. Shared endpoints are not exact brand totals. A separate IP-country view requires verified access-log geography; order country is never reused as visitor geography.',
  },
  cdn: {
    name: 'ECom CDN',
    origin: 'Separate CDN platform metrics',
    brand: false,
    country: false,
    scale: 0.43,
    coverage: 'Source-specific metric availability must be verified.',
    note: 'Brand and country filters not applied: this source is a separate CDN profile total.',
  },
  ingress: {
    name: 'ECom ingress',
    origin: 'Recorded ingress access logs / Loki',
    brand: true,
    country: false,
    scale: 7.1,
    coverage: 'Recorded logs only; ingestion coverage is not independently guaranteed.',
    note: 'Host-mapped brand filter applies. Order-country filter does not apply to origin requests. Requests are not unique visitors.',
  },
  macula: {
    name: 'Macula gateway',
    origin: 'Azure Application Gateway ResponseStatus',
    brand: false,
    country: false,
    scale: 1.7,
    coverage: 'Status families only. Exact 200/500 codes unavailable from this metric.',
    note: 'Brand and country filters not applied. 2xx is a family and must never be labelled "200".',
  },
}
