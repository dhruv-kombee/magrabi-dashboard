import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const workspaceDir = path.resolve(rootDir, '..')

// Simple .env parser that does not require external dependencies
function parseEnvContent(content) {
  const env = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim()
      let val = trimmed.slice(eqIdx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      env[key] = val
    }
  }
  return env
}

function loadEnvFile(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return parseEnvContent(content)
    } catch {
      // Ignore read errors
    }
  }
  return {}
}

let lastEnvMtime = 0
let cachedPlatformEnv = {}

function getPlatformEnv() {
  const envPath = path.join(rootDir, '.env')
  try {
    if (fs.existsSync(envPath)) {
      const stat = fs.statSync(envPath)
      if (stat.mtimeMs !== lastEnvMtime) {
        lastEnvMtime = stat.mtimeMs
        cachedPlatformEnv = parseEnvContent(fs.readFileSync(envPath, 'utf-8'))
      }
    } else {
      cachedPlatformEnv = {}
    }
  } catch {
    // Ignore read errors
  }
  return cachedPlatformEnv
}

// Fallback secrets from workspace .secrets/ (if existing)
const saleorSecrets = loadEnvFile(path.join(workspaceDir, '.secrets', 'saleor.env'))
const maculaSecrets = loadEnvFile(path.join(workspaceDir, '.secrets', 'macula.env'))
const grafanaSecrets = loadEnvFile(path.join(workspaceDir, '.secrets', 'grafana.env'))
const azureSecrets = loadEnvFile(path.join(workspaceDir, '.secrets', 'azure.env'))
const dashboardAuthSecrets = loadEnvFile(path.join(workspaceDir, '.secrets', 'dashboard-auth.env'))

/**
 * Get environment variable with priority:
 * 1. process.env (Docker / K8s / Azure App Settings)
 * 2. commerce-intelligence-platform/.env (hot-reloaded on change)
 * 3. .secrets/*.env (local workstation fallbacks)
 * 4. defaultValue
 */
export function getEnv(key, defaultValue = '') {
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return process.env[key]
  }
  const platformEnv = getPlatformEnv()
  if (platformEnv[key] !== undefined && platformEnv[key] !== '') {
    return platformEnv[key]
  }
  if (saleorSecrets[key] !== undefined && saleorSecrets[key] !== '') {
    return saleorSecrets[key]
  }
  if (maculaSecrets[key] !== undefined && maculaSecrets[key] !== '') {
    return maculaSecrets[key]
  }
  if (grafanaSecrets[key] !== undefined && grafanaSecrets[key] !== '') {
    return grafanaSecrets[key]
  }
  if (azureSecrets[key] !== undefined && azureSecrets[key] !== '') {
    return azureSecrets[key]
  }
  if (dashboardAuthSecrets[key] !== undefined && dashboardAuthSecrets[key] !== '') {
    return dashboardAuthSecrets[key]
  }
  return defaultValue
}

export function hasEnv(key) {
  const val = getEnv(key)
  return val !== '' && val !== null && val !== undefined
}

export const config = {
  get port() { return parseInt(getEnv('PORT', '5174'), 10) },
  get isProd() { return getEnv('NODE_ENV') === 'production' },
  get requestTimeoutMs() { return Math.max(1000, parseInt(getEnv('CONNECTOR_TIMEOUT_MS', '12000'), 10) || 12000) },
  get corsOrigins() { return getEnv('CORS_ALLOWED_ORIGINS', '').split(',').map((v) => v.trim()).filter(Boolean) },

  // Dashboard authentication (server-side only)
  auth: {
    get username() { return getEnv('AUTH_USERNAME') },
    get passwordHash() { return getEnv('AUTH_PASSWORD_HASH') },
    get sessionSecret() { return getEnv('AUTH_SESSION_SECRET') },
    get sessionTimeoutSeconds() {
      const minutes = parseInt(getEnv('AUTH_SESSION_TIMEOUT_MINUTES', '10'), 10)
      return Math.min(60, Math.max(1, Number.isFinite(minutes) ? minutes : 10)) * 60
    },
  },
  
  // Saleor
  saleor: {
    get graphqlUrl() { return getEnv('SALEOR_GRAPHQL_URL', 'https://ecom-app-api.magrabi.com/graphql/') },
    get username() { return getEnv('SALEOR_USERNAME') },
    get password() { return getEnv('SALEOR_PASSWORD') },
    get cacheTtlMs() { return parseInt(getEnv('SALEOR_CACHE_TTL', '60'), 10) * 1000 },
    get maxRevenuePages() { return Math.max(1, parseInt(getEnv('SALEOR_MAX_REVENUE_PAGES', '250'), 10) || 250) },
  },

  // Macula OMS
  macula: {
    get apiUrl() { return getEnv('MACULA_API_URL', 'https://macula-api.magrabi.com/api/v1/order/search') },
    get dashboardUrl() { return getEnv('MACULA_DASHBOARD_URL', 'https://macula-v2.magrabi.com/') },
    get username() { return getEnv('MACULA_USERNAME') },
    get password() { return getEnv('MACULA_PASSWORD') },
    get token() { return getEnv('MACULA_TOKEN') },
  },

  // Gateways
  checkout: {
    get apiUrl() { return getEnv('CHECKOUT_API_URL', 'https://api.checkout.com') },
    get secretKey() { return getEnv('CHECKOUT_SECRET_KEY') },
    get channelId() { return getEnv('CHECKOUT_PROCESSING_CHANNEL_ID') },
    get reportPath() { return getEnv('CHECKOUT_REPORT_PATH', '') },
  },
  tabby: {
    get apiUrl() { return getEnv('TABBY_API_URL', 'https://api.tabby.ai/api/v2') },
    get secretKey() { return getEnv('TABBY_SECRET_KEY') },
    get reportPath() { return getEnv('TABBY_REPORT_PATH', '/payments') },
  },
  tamara: {
    get apiUrl() { return getEnv('TAMARA_API_URL', 'https://api.tamara.co') },
    get apiToken() { return getEnv('TAMARA_API_TOKEN') },
    get reportPath() { return getEnv('TAMARA_REPORT_PATH', '/orders') },
  },
  paymob: {
    get apiUrl() { return getEnv('PAYMOB_API_URL', 'https://accept.paymob.com/api') },
    get apiKey() { return getEnv('PAYMOB_API_KEY') },
    get reportPath() { return getEnv('PAYMOB_REPORT_PATH', '') },
  },

  // Azure Front Door / Monitor
  azure: {
    get tenantId() { return getEnv('AZURE_TENANT_ID', 'cc9b4a8c-1b70-4347-acd3-80d32f102f2f') },
    get clientId() { return getEnv('AZURE_CLIENT_ID') },
    get clientSecret() { return getEnv('AZURE_CLIENT_SECRET') },
    get username() { return getEnv('AZURE_USERNAME') },
    get password() { return getEnv('AZURE_PASSWORD') },
    get subscriptionId() { return getEnv('AZURE_SUBSCRIPTION_ID', '72bde893-fa26-4129-a31f-648b81a48153') },
    get resourceGroup() { return getEnv('AZURE_RESOURCE_GROUP', 'rg-mepu-common-uaenorth-001') },
    get profileName() { return getEnv('AZURE_FRONTDOOR_PROFILE', 'frontdoor-mepu-common-uaenorth-001') },
    get metricNames() { return getEnv('AZURE_MONITOR_METRIC_NAMES', 'RequestCount,ClientLatency') },
  },

  // Grafana / APM
  grafana: {
    get ecomUrl() { return getEnv('ECOM_GRAFANA_URL', 'https://ecom-grafana.test-magrabi.com') },
    get ecomUser() { return getEnv('ECOM_GRAFANA_USER', 'digitalworks') },
    get ecomPassword() { return getEnv('ECOM_GRAFANA_PASSWORD') },
    get ecomToken() { return getEnv('ECOM_GRAFANA_TOKEN') },
    get maculaUrl() { return getEnv('MACULA_GRAFANA_URL', 'http://20.174.44.78/') },
    get maculaUser() { return getEnv('MACULA_GRAFANA_USER', 'admin') },
    get maculaPassword() { return getEnv('MACULA_GRAFANA_PASSWORD') },
    get prometheusUid() { return getEnv('PROMETHEUS_DATASOURCE_UID') },
    get latencyQuery() { return getEnv('GRAFANA_LATENCY_QUERY') },
    get cpuQuery() { return getEnv('GRAFANA_CPU_QUERY') },
    get memoryQuery() { return getEnv('GRAFANA_MEMORY_QUERY') },
  },

  // Natural-language assistant (server-side only; never exposed to the browser)
  assistant: {
    get geminiApiKey() { return getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_API_KEY') },
    get model() { return getEnv('GEMINI_MODEL', 'gemini-3.1-flash-lite') },
    get maxHistoryMessages() { return parseInt(getEnv('ASSISTANT_MAX_HISTORY', '8'), 10) },
  },

  // Alerts
  alerts: {
    get deliveryEnabled() { return getEnv('ALERT_DELIVERY_ENABLED', 'false').toLowerCase() === 'true' },
    get teamsWebhookUrl() { return getEnv('TEAMS_WEBHOOK_URL') },
    get smtpHost() { return getEnv('SMTP_HOST') },
    get smtpPort() { return parseInt(getEnv('SMTP_PORT', '587'), 10) },
    get smtpUser() { return getEnv('SMTP_USER') },
    get smtpPassword() { return getEnv('SMTP_PASSWORD') },
    get recipients() { return getEnv('ALERT_EMAIL_RECIPIENTS', '') },
  },
}
