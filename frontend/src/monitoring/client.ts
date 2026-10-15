import { isTrafficHost } from './trafficModel.ts'

/** Same-origin, GET-only client. Import/construction performs no requests. */
export function createMonitoringClient(fetcher: typeof fetch) {
  async function get(path: string, signal: AbortSignal, limit: number): Promise<unknown> {
    const response = await fetcher(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin',
      redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal })
    if (!response.ok || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel()
      throw new Error('monitoring_unavailable')
    }
    const declared = response.headers.get('Content-Length')
    if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > limit)) {
      await response.body?.cancel()
      throw new Error('monitoring_response_limit')
    }
    if (!response.body) throw new Error('monitoring_empty_response')
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0, text = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (signal.aborted) throw new Error('monitoring_cancelled')
        if (done) break
        bytes += value.byteLength
        if (bytes > limit) throw new Error('monitoring_response_limit')
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      return JSON.parse(text)
    } catch {
      await reader.cancel().catch(() => {})
      throw new Error('monitoring_response_unavailable')
    } finally { reader.releaseLock() }
  }
  return {
    async configured(signal: AbortSignal): Promise<boolean> {
      const value = await get('/api/monitoring/v1/environments', signal, 64_000) as { environments?: unknown }
      if (!value || !Array.isArray(value.environments) || value.environments.length !== 4) throw new Error('monitoring_configuration_unavailable')
      const ids = new Set<string>()
      let sitEnabled = false
      for (const env of value.environments) {
        if (!env || typeof env !== 'object' || !['sit', 'dev', 'beta', 'prod'].includes(env.id)
          || typeof env.enabled !== 'boolean' || ids.has(env.id) || (env.id !== 'sit' && env.enabled)) throw new Error('monitoring_configuration_unavailable')
        ids.add(env.id)
        if (env.id === 'sit') sitEnabled = env.enabled
      }
      return sitEnabled
    },
    async trace(id: string, signal: AbortSignal): Promise<unknown> {
      // Tempo strips leading zeros from trace IDs, so accept a short ID and restore the
      // canonical 32-character form before calling the API.
      const canonical = id.toLowerCase().padStart(32, '0')
      if (!/^[0-9a-f]{32}$/.test(canonical) || /^0+$/.test(canonical)) throw new Error('invalid_trace_id')
      return get('/api/monitoring/v1/sit/traces/' + canonical, signal, 5_000_000)
    },
    async dashboard(signal: AbortSignal): Promise<unknown> {
      return get('/api/monitoring/v1/sit/dashboard', signal, 200_000)
    },
    async serviceMap(signal: AbortSignal): Promise<unknown> {
      return get('/api/monitoring/v1/sit/service-map', signal, 200_000)
    },
    async rum(signal: AbortSignal): Promise<unknown> {
      return get('/api/monitoring/v1/sit/rum', signal, 100_000)
    },
    async traffic(host: string, signal: AbortSignal): Promise<unknown> {
      if (!isTrafficHost(host)) throw new Error('unsupported_site')
      return get('/api/monitoring/v1/sit/sites/' + host + '/requests?window=5m', signal, 20_000)
    },
    async candidates(component: string, signal: AbortSignal): Promise<unknown> {
      // Mirrors the components that can carry trace_search: SIT_SERVICES ∩ the catalogue.
      if (!/^macula-sit\/(api-gateway|app-api|auth-server|external-api|batch-processor|singlemicro|integrations)$/.test(component)
        && !/^saleor-sit\/saleor-(admin|app|checkout|validator)-api$/.test(component)
        && !/^storefront-retail-sit\/(retail|iclinic|rivoli|shodo|zwei)-storefront$/.test(component)) throw new Error('unsupported_component')
      return get('/api/monitoring/v1/sit/components/' + component + '/traces', signal, 10_000)
    },
  }
}
