export type SectionKey =
  | 'overview'
  | 'orders'
  | 'journey'
  | 'traffic'
  | 'infra'
  | 'sources'
  | 'alerts'

export type BrandFilter = 'all' | 'Magrabi' | 'DoctorM'
export type CountryFilter = 'all' | 'AE' | 'SA' | 'EG' | 'QA' | 'KW'
export type TimezoneKey = 'Dubai' | 'UTC' | 'IST'
export type TrafficSourceKey = 'frontdoor' | 'cdn' | 'ingress' | 'macula'
export type ErrorKind = 'graphql' | 'timeout' | 'page'

export interface FixtureRecord {
  t: number
  code: string
  brand: string
  orders: number
  cash: number
  success: number
  failed: number
  pending: number
  attempts: number
  revenue: number
  steps: number[]
  requests: number
}

export interface AggregatedData {
  rows: FixtureRecord[]
  orders: number
  attempts: number
  success: number
  failed: number
  pending: number
  cash: number
  requests: number
  steps: number[]
}

export interface CountryInfo {
  name: string
  currency: string
  weight: number
}
