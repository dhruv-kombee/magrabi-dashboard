import { config, hasEnv } from '../config.js'
import { connectorError, fetchJson, publicConnectorResult } from './http.js'

export function isInfraConfigured() {
  return hasEnv('ECOM_GRAFANA_TOKEN') || (hasEnv('ECOM_GRAFANA_USER') && hasEnv('ECOM_GRAFANA_PASSWORD'))
}

export function hasGrafanaMetricContract(uid = config.grafana.prometheusUid, latencyQuery = config.grafana.latencyQuery) {
  return Boolean(uid && latencyQuery)
}

const authHeader = () => config.grafana.ecomToken ? `Bearer ${config.grafana.ecomToken}` : `Basic ${Buffer.from(`${config.grafana.ecomUser}:${config.grafana.ecomPassword}`).toString('base64')}`

function parsePrometheusValues(payload) {
  const rows = payload?.data?.result
  if (!Array.isArray(rows)) return null
  return rows.flatMap((series) => (series.values || []).map(([timestamp, value]) => ({ timestamp: Number(timestamp) * 1000, value: Number(value) })))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
}

async function queryPrometheus(query, start, end) {
  const base = config.grafana.ecomUrl.replace(/\/$/, '')
  const url = new URL(`${base}/api/datasources/proxy/uid/${encodeURIComponent(config.grafana.prometheusUid)}/api/v1/query_range`)
  url.searchParams.set('query', query)
  url.searchParams.set('start', String(Math.floor(start / 1000)))
  url.searchParams.set('end', String(Math.floor(end / 1000)))
  url.searchParams.set('step', '300')
  const { response, payload } = await fetchJson(url, { headers: { Authorization: authHeader(), Accept: 'application/json' } }, config.requestTimeoutMs)
  if (!response.ok) throw new Error(`Grafana metric query returned HTTP ${response.status}.`)
  const values = parsePrometheusValues(payload)
  if (!values) throw new Error('Grafana metric response is missing Prometheus result values.')
  return values
}

export async function fetchInfraTelemetry(options = {}) {
  const empty = { latencyTrends: [], services: [], database: null }
  if (!isInfraConfigured()) return publicConnectorResult({ status: 'NOT_CONFIGURED', configured: false, source: 'Grafana / Prometheus', missing: ['ECOM_GRAFANA_TOKEN'], ...empty })
  const checkedAt = new Date().toISOString()
  try {
    const { response, payload } = await fetchJson(`${config.grafana.ecomUrl.replace(/\/$/, '')}/api/health`, { headers: { Authorization: authHeader(), Accept: 'application/json' } }, config.requestTimeoutMs)
    if (response.status === 401 || response.status === 403) return publicConnectorResult({ status: 'AUTHENTICATION_FAILED', configured: true, source: 'Grafana', httpStatus: response.status, checkedAt, ...empty })
    if (!response.ok) return publicConnectorResult({ status: 'ERROR', configured: true, source: 'Grafana', httpStatus: response.status, error: `Grafana health returned HTTP ${response.status}.`, checkedAt, ...empty })
    if (!payload || typeof payload !== 'object') return publicConnectorResult({ status: 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING', configured: true, live: true, source: 'Grafana', checkedAt, ...empty })
    if (!hasGrafanaMetricContract()) {
      return publicConnectorResult({
        status: 'METRICS_UNAVAILABLE', configured: true, live: true, metricsAvailable: false, source: 'Grafana health', checkedAt,
        health: { database: payload.database ?? null, version: payload.version ?? null }, ...empty,
        message: 'Grafana health is verified, but no Prometheus datasource/query contract is configured.',
      })
    }
    const end = Number(options.end) || Date.now()
    const start = Number(options.start) || end - 3_600_000
    const [latency, cpu, memory] = await Promise.all([
      queryPrometheus(config.grafana.latencyQuery, start, end),
      config.grafana.cpuQuery ? queryPrometheus(config.grafana.cpuQuery, start, end) : Promise.resolve([]),
      config.grafana.memoryQuery ? queryPrometheus(config.grafana.memoryQuery, start, end) : Promise.resolve([]),
    ])
    return publicConnectorResult({
      status: latency.length ? 'LIVE_VERIFIED' : 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING', configured: true, live: true, metricsAvailable: latency.length > 0,
      source: 'Grafana Prometheus datasource', checkedAt, latencyTrends: latency.map((point) => ({ timestamp: point.timestamp, p95: point.value })),
      cpuTrends: cpu, memoryTrends: memory, services: [], database: null,
    })
  } catch (error) {
    return publicConnectorResult({ ...connectorError(error), configured: true, source: 'Grafana / Prometheus', checkedAt, ...empty })
  }
}
