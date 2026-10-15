import { decodeCatalog, decodeReport, decodeTicket, isReportId, matchesRange } from './model.ts'
import type { TrafficInput } from './model.ts'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export class TrafficCountsError extends Error {
  readonly code: 'cancelled' | 'timeout' | 'unavailable' | 'invalid_response' | 'forbidden' | 'busy'
  constructor(code: TrafficCountsError['code']) { super(code); this.code = code }
}

/** Fixed same-origin routes, no retries or upstream error text, one bounded request at a time. */
export function createTrafficCountsClient(fetcher: Fetcher = (...args) => fetch(...args)) {
  async function json(path: string, signal: AbortSignal, input?: TrafficInput) {
    if (signal.aborted) throw new TrafficCountsError('cancelled')
    const controller = new AbortController()
    let expired = false
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { expired = true; controller.abort() }, 20_000)
    try {
      const response = await fetcher(path, { method: input ? 'POST' : 'GET', credentials: 'same-origin',
        redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: input ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Traffic-Request': '1' } : { Accept: 'application/json' },
        ...(input ? { body: JSON.stringify(input) } : {}) })
      if (response.status === 401 || response.status === 403) throw new TrafficCountsError('forbidden')
      if (response.status === 429) throw new TrafficCountsError('busy')
      if (!response.ok) throw new TrafficCountsError('unavailable')
      if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new TrafficCountsError('invalid_response')
      const declared = Number(response.headers.get('Content-Length'))
      if (Number.isFinite(declared) && declared > 8_000_000) throw new TrafficCountsError('invalid_response')
      const reader = response.body?.getReader()
      if (!reader) throw new TrafficCountsError('invalid_response')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let size = 0, body = ''
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 8_000_000) { await reader.cancel(); throw new TrafficCountsError('invalid_response') }
          body += decoder.decode(chunk.value, { stream: true })
        }
        body += decoder.decode()
      } finally { reader.releaseLock() }
      if (signal.aborted) throw new TrafficCountsError('cancelled')
      return JSON.parse(body) as unknown
    } catch (error) {
      if (signal.aborted) throw new TrafficCountsError('cancelled')
      if (expired) throw new TrafficCountsError('timeout')
      if (error instanceof TrafficCountsError) throw error
      throw new TrafficCountsError('unavailable')
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
  }
  async function decode<T>(read: () => Promise<unknown>, parse: (raw: unknown) => T) {
    const raw = await read()
    try { return parse(raw) } catch { throw new TrafficCountsError('invalid_response') }
  }
  return {
    sources: (signal: AbortSignal) => decode(() => json('/api/insights/traffic/sources', signal), decodeCatalog),
    create: (input: TrafficInput, signal: AbortSignal) => decode(() => json('/api/insights/traffic/reports', signal, input), decodeTicket),
    report: async (reportId: string, signal: AbortSignal, input?: TrafficInput) => {
      if (!isReportId(reportId)) throw new TrafficCountsError('invalid_response')
      return decode(() => json(`/api/insights/traffic/reports/${reportId}`, signal), raw => {
        const report = decodeReport(raw, reportId)
        if (input && !matchesRange(report, input)) throw new Error('range_mismatch')
        return report
      })
    },
  }
}
export function csvPath(reportId: string): string | null {
  return isReportId(reportId) ? `/api/insights/traffic/reports/${reportId}/export.csv` : null
}
export function trafficErrorMessage(error: unknown): string {
  if (!(error instanceof TrafficCountsError)) return 'Could not read traffic counts. Please try again.'
  return { cancelled: 'Report loading stopped.', timeout: 'The request timed out. No zero counts have been inferred.',
    unavailable: 'Traffic counts are unavailable. No zero counts have been inferred.',
    invalid_response: 'Traffic data failed validation and has not been displayed.',
    forbidden: 'Your session does not have access. Sign in to the portal again.',
    busy: 'A report is already running or the source is busy. Please wait before trying again.' }[error.code]
}
export function pollDelay(signal: AbortSignal, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new TrafficCountsError('cancelled')); return }
    const abort = () => { clearTimeout(timer); reject(new TrafficCountsError('cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
