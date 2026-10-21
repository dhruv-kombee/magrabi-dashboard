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
  return defaultValue
}

export function hasEnv(key) {
  const val = getEnv(key)
  return val !== '' && val !== null && val !== undefined
}

export const config = {
  get port() { return parseInt(getEnv('PORT', '5174'), 10) },
  get isProd() { return getEnv('NODE_ENV') === 'production' },
  
  // Saleor
  saleor: {
    get graphqlUrl() { return getEnv('SALEOR_GRAPHQL_URL', 'https://ecom-app-api.magrabi.com/graphql/') },
    get username() { return getEnv('SALEOR_USERNAME') },
    get password() { return getEnv('SALEOR_PASSWORD') },
    get cacheTtlMs() { return parseInt(getEnv('SALEOR_CACHE_TTL', '60'), 10) * 1000 },
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
  },
  tabby: {
    get apiUrl() { return getEnv('TABBY_API_URL', 'https://api.tabby.ai/api/v2') },
    get secretKey() { return getEnv('TABBY_SECRET_KEY') },
  },
  tamara: {
    get apiUrl() { return getEnv('TAMARA_API_URL', 'https://api.tamara.co') },
    get apiToken() { return getEnv('TAMARA_API_TOKEN') },
  },
  paymob: {
    get apiUrl() { return getEnv('PAYMOB_API_URL', 'https://accept.paymob.com/api') },
    get apiKey() { return getEnv('PAYMOB_API_KEY') },
  },

  // Azure Front Door / Monitor
  azure: {
    get tenantId() { return getEnv('AZURE_TENANT_ID') },
    get clientId() { return getEnv('AZURE_CLIENT_ID') },
    get clientSecret() { return getEnv('AZURE_CLIENT_SECRET') },
    get subscriptionId() { return getEnv('AZURE_SUBSCRIPTION_ID', '72bde893-fa26-4129-a31f-648b81a48153') },
    get resourceGroup() { return getEnv('AZURE_RESOURCE_GROUP', 'rg-mepu-prod-uaenorth-001') },
    get profileName() { return getEnv('AZURE_FRONTDOOR_PROFILE', 'frontdoor-ecom-prod-uaenorth-001') },
  },

  // Grafana / APM
  grafana: {
    get ecomUrl() { return getEnv('ECOM_GRAFANA_URL', 'https://ecom-grafana.test-magrabi.com') },
    get ecomUser() { return getEnv('ECOM_GRAFANA_USER', 'digitalworks') },
    get ecomPassword() { return getEnv('ECOM_GRAFANA_PASSWORD', 'digitalworks@2025') },
    get ecomToken() { return getEnv('ECOM_GRAFANA_TOKEN') },
    get maculaUrl() { return getEnv('MACULA_GRAFANA_URL', 'http://20.174.44.78/') },
    get maculaUser() { return getEnv('MACULA_GRAFANA_USER', 'admin') },
    get maculaPassword() { return getEnv('MACULA_GRAFANA_PASSWORD', 'macula@!@#2026') },
    get prometheusUid() { return getEnv('PROMETHEUS_DATASOURCE_UID') },
  },

  // Alerts
  alerts: {
    get teamsWebhookUrl() { return getEnv('TEAMS_WEBHOOK_URL') },
    get smtpHost() { return getEnv('SMTP_HOST') },
    get smtpPort() { return parseInt(getEnv('SMTP_PORT', '587'), 10) },
    get smtpUser() { return getEnv('SMTP_USER') },
    get smtpPassword() { return getEnv('SMTP_PASSWORD') },
    get recipients() { return getEnv('ALERT_EMAIL_RECIPIENTS', '') },
  },
}
