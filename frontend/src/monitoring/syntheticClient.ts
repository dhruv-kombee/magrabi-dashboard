import { decodeSynthetics, validSyntheticQuery } from './syntheticModel.ts'
import type { SyntheticPage, SyntheticQuery } from './syntheticModel.ts'

export type SyntheticLoader = (query: SyntheticQuery, signal: AbortSignal) => Promise<unknown>
export class SyntheticRequestError extends Error {
  readonly code: 'cancelled' | 'timed_out' | 'unavailable' | 'unauthorized'
  constructor(code: SyntheticRequestError['code']) { super(code); this.code = code }
}
const ENDPOINT = '/api/monitoring/v1/sit/synthetics'
const MAX_BYTES = 256 * 1024

/** Fixed same-origin GET only. The server-to-server bearer token never reaches this client. */
export function createSyntheticClient(fetcher: typeof fetch = globalThis.fetch): SyntheticLoader {
  return async (query, signal) => {
    if (!validSyntheticQuery(query)) throw new SyntheticRequestError('unavailable')
    if (signal.aborted) throw new SyntheticRequestError('cancelled')
    try {
      const response = await fetcher(`${ENDPOINT}?limit=${query.limit}&offset=${query.offset}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal,
      })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        throw new SyntheticRequestError('unauthorized')
      }
      if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
        || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES || !response.body) {
        await response.body?.cancel()
        throw new SyntheticRequestError('unavailable')
      }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
      let size = 0, body = ''
      try {
        while (true) {
          const chunk = await reader.read()
          if (signal.aborted) throw new SyntheticRequestError('cancelled')
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_BYTES) throw new SyntheticRequestError('unavailable')
          body += decoder.decode(chunk.value, { stream: true })
        }
        body += decoder.decode()
        return JSON.parse(body) as unknown
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch (error) {
      if (signal.aborted) throw new SyntheticRequestError('cancelled')
      if (error instanceof SyntheticRequestError) throw error
      throw new SyntheticRequestError('unavailable')
    }
  }
}

/** Deadline also settles an injected loader that ignores abort; raw errors are never surfaced. */
export async function loadSyntheticPage(load: SyntheticLoader, query: SyntheticQuery,
  controller: AbortController, timeoutMs = 10_000): Promise<SyntheticPage> {
  if (!validSyntheticQuery(query)) throw new SyntheticRequestError('unavailable')
  if (controller.signal.aborted) throw new SyntheticRequestError('cancelled')
  let timedOut = false, onAbort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SyntheticRequestError(timedOut ? 'timed_out' : 'cancelled'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const value = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new SyntheticRequestError('cancelled')
      return load(query, controller.signal)
    }), cancelled])
    if (controller.signal.aborted) throw new SyntheticRequestError(timedOut ? 'timed_out' : 'cancelled')
    return decodeSynthetics(value, query)
  } catch (error) {
    if (error instanceof SyntheticRequestError) throw error
    throw new SyntheticRequestError('unavailable')
  } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort) }
}
