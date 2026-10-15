import { decodeTraceSummary } from './traceResponse.ts'

export type TraceLoader = (id: string, signal: AbortSignal) => Promise<unknown>
export class TraceLookupError extends Error {
  readonly code: 'cancelled' | 'timed_out' | 'unavailable'
  constructor(code: 'cancelled' | 'timed_out' | 'unavailable') { super(code); this.code = code }
}

/** Bound the UI wait even when an injected provider ignores cancellation. No default network. */
export async function lookupTrace(load: TraceLoader, id: string, controller: AbortController, timeoutMs = 15_000) {
  if (controller.signal.aborted) throw new TraceLookupError('cancelled')
  let expired = false
  let onAbort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new TraceLookupError(expired ? 'timed_out' : 'cancelled'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => { expired = true; controller.abort() }, timeoutMs)
  try {
    const value = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new TraceLookupError('cancelled')
      return load(id, controller.signal)
    }), cancelled])
    if (controller.signal.aborted) throw new TraceLookupError(expired ? 'timed_out' : 'cancelled')
    return decodeTraceSummary(value, id)
  } catch (error) {
    if (error instanceof TraceLookupError) throw error
    throw new TraceLookupError('unavailable') // Never surface provider bodies or exception text.
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
