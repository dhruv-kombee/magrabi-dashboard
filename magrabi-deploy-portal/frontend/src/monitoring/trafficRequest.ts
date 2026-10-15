import { decodeTraffic, isTrafficHost } from './trafficModel.ts'

export type TrafficLoader = (host: string, signal: AbortSignal) => Promise<unknown>
export class TrafficRequestError extends Error {
  readonly code: 'cancelled' | 'timed_out' | 'unavailable'
  constructor(code: 'cancelled' | 'timed_out' | 'unavailable') { super(code); this.code = code }
}

/** A deadline settles even if an injected loader ignores abort. Errors never echo providers. */
export async function loadSiteTraffic(load: TrafficLoader, host: string, controller: AbortController, timeoutMs = 15_000) {
  if (controller.signal.aborted) throw new TrafficRequestError('cancelled')
  if (!isTrafficHost(host)) throw new TrafficRequestError('unavailable')
  let expired = false, onAbort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new TrafficRequestError(expired ? 'timed_out' : 'cancelled'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => { expired = true; controller.abort() }, timeoutMs)
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new TrafficRequestError('cancelled')
      return load(host, controller.signal)
    }), cancelled])
    if (controller.signal.aborted) throw new TrafficRequestError(expired ? 'timed_out' : 'cancelled')
    return decodeTraffic(result, host)
  } catch (error) {
    if (error instanceof TrafficRequestError) throw error
    throw new TrafficRequestError('unavailable')
  } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort) }
}
