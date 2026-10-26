import { config, hasEnv } from '../config.js'
import { connectorError, fetchJson, publicConnectorResult } from './http.js'

export function getGatewaysConfigurationStatus() {
  return {
    checkout: { configured: hasEnv('CHECKOUT_SECRET_KEY'), requiredKeys: ['CHECKOUT_SECRET_KEY'], apiUrl: config.checkout.apiUrl, reportPath: config.checkout.reportPath, name: 'Checkout.com', scope: 'Read-only reporting; query contract must be configured' },
    tabby: { configured: hasEnv('TABBY_SECRET_KEY'), requiredKeys: ['TABBY_SECRET_KEY'], apiUrl: config.tabby.apiUrl, reportPath: config.tabby.reportPath, name: 'Tabby BNPL', scope: 'Read-only merchant payment inquiry' },
    tamara: { configured: hasEnv('TAMARA_API_TOKEN'), requiredKeys: ['TAMARA_API_TOKEN'], apiUrl: config.tamara.apiUrl, reportPath: config.tamara.reportPath, name: 'Tamara BNPL', scope: 'Read-only merchant order inquiry' },
    paymob: { configured: hasEnv('PAYMOB_API_KEY'), requiredKeys: ['PAYMOB_API_KEY'], apiUrl: config.paymob.apiUrl, reportPath: config.paymob.reportPath, name: 'Paymob', scope: 'Read-only reporting; query contract must be configured' },
  }
}

const joinUrl = (base, pathname) => `${base.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`
const responseHasRecords = (payload) => Array.isArray(payload) || Array.isArray(payload?.data) || Array.isArray(payload?.results) || Array.isArray(payload?.payments) || Array.isArray(payload?.orders)

export async function queryProvider(key, details) {
  if (!details.configured) return publicConnectorResult({ status: 'NOT_CONFIGURED', configured: false, source: details.name, missing: details.requiredKeys })
  if (!details.reportPath) return publicConnectorResult({ status: 'CODE_INCOMPLETE', configured: true, source: details.name, message: `No verified read-only reporting path is configured for ${details.name}.` })
  const credentials = { checkout: config.checkout.secretKey, tabby: config.tabby.secretKey, tamara: config.tamara.apiToken, paymob: config.paymob.apiKey }
  try {
    const { response, payload } = await fetchJson(joinUrl(details.apiUrl, details.reportPath), {
      method: 'GET', headers: { Authorization: `Bearer ${credentials[key]}`, Accept: 'application/json' },
    }, config.requestTimeoutMs)
    if (response.status === 401 || response.status === 403) return publicConnectorResult({ status: 'AUTHENTICATION_FAILED', configured: true, source: details.name, httpStatus: response.status })
    if (!response.ok) return publicConnectorResult({ status: 'ERROR', configured: true, source: details.name, httpStatus: response.status, error: `Read-only request returned HTTP ${response.status}.` })
    if (!payload || typeof payload !== 'object') return publicConnectorResult({ status: 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING', configured: true, live: true, source: details.name, httpStatus: response.status })
    return publicConnectorResult({
      status: responseHasRecords(payload) ? 'LIVE_VERIFIED' : 'CONNECTED_BUT_REQUIRED_FIELDS_MISSING', configured: true, live: true, metricsAvailable: false,
      source: details.name, httpStatus: response.status, responseShape: Array.isArray(payload) ? 'array' : Object.keys(payload).slice(0, 12),
      message: 'Authentication and response shape verified. Success/failure metrics remain unavailable until provider fields are mapped.',
    })
  } catch (error) {
    return publicConnectorResult({ ...connectorError(error), configured: true, source: details.name })
  }
}

export async function fetchGatewayTelemetry() {
  const configuration = getGatewaysConfigurationStatus()
  const providers = Object.fromEntries(await Promise.all(Object.entries(configuration).map(async ([key, details]) => [key, await queryProvider(key, details)])))
  const anyConfigured = Object.values(configuration).some((item) => item.configured)
  const anyLive = Object.values(providers).some((item) => item.status === 'LIVE_VERIFIED')
  return publicConnectorResult({
    status: anyLive ? 'LIVE_VERIFIED' : anyConfigured ? 'CONFIGURED_BUT_NOT_VERIFIED' : 'NOT_CONFIGURED', configured: anyConfigured, live: anyLive,
    metricsAvailable: false, source: 'Payment gateway read-only reporting APIs', connectors: configuration, providers,
    gatewayTrends: [], methodTrends: [], message: 'No gateway success rate or full-window method total is emitted without verified provider-side fields.',
  })
}
