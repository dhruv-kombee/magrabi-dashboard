const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /basic\s+[a-z0-9+/=]+/gi,
  /([?&](?:key|token|api_key|access_token|client_secret)=)[^&\s]+/gi,
]

export function redactError(error) {
  let message = error instanceof Error ? error.message : String(error || 'Unknown connector error')
  for (const pattern of SECRET_PATTERNS) message = message.replace(pattern, '$1[REDACTED]')
  return message.slice(0, 500)
}

export function connectorError(error, fallback = 'Connector request failed.') {
  if (error?.name === 'AbortError') return { status: 'TIMEOUT', error: 'The source did not respond before the timeout.' }
  const message = redactError(error)
  return { status: 'ERROR', error: message || fallback }
}

export async function fetchJson(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const contentType = response.headers.get('content-type') || ''
    let payload = null
    if (contentType.includes('json')) {
      try { payload = await response.json() } catch { throw new Error(`Source returned malformed JSON (HTTP ${response.status}).`) }
    } else {
      const text = await response.text()
      if (text.trim()) {
        try { payload = JSON.parse(text) } catch { payload = null }
      }
    }
    return { response, payload }
  } finally {
    clearTimeout(timeout)
  }
}

export function publicConnectorResult({
  status,
  configured,
  live = false,
  metricsAvailable = false,
  source,
  checkedAt = new Date().toISOString(),
  missing = [],
  error,
  message,
  ...data
}) {
  return {
    status,
    configured: Boolean(configured),
    live: Boolean(live),
    metricsAvailable: Boolean(metricsAvailable),
    source,
    checkedAt,
    missing,
    ...(error ? { error: redactError(error) } : {}),
    ...(message ? { message } : {}),
    ...data,
  }
}
