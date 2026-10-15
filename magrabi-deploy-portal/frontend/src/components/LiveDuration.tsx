import { useEffect, useState } from 'react'

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** "1h 04m 12s" / "4m 12s" / "12s". Trailing units are zero-padded but the leading one never is, so
 * a ticking duration keeps a stable width instead of jittering every time a unit rolls over. */
function formatDuration(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`
  return `${seconds}s`
}

function toMillis(iso: string | null): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
}

export interface LiveDurationProps {
  startedOn: string | null
  completedOn: string | null
  durationSeconds: number | null
  live: boolean
  className?: string
}

export function LiveDuration({ startedOn, completedOn, durationSeconds, live, className }: LiveDurationProps) {
  const startedMs = toMillis(startedOn)
  // A deployment the backend calls in-flight but that has no usable start time has nothing to tick
  // from, so it falls back to the static rendering path rather than counting up from the epoch.
  const ticking = live && startedMs !== null
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!ticking) return
    // Re-read the clock the moment a card flips to in-flight: otherwise the first second rendered
    // is measured against whenever this component happened to mount, which can be minutes stale.
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])

  let seconds: number | null = null
  if (ticking && startedMs !== null) {
    // The browser clock and Azure DevOps' clock routinely disagree by a few seconds; formatDuration
    // floors negatives to zero rather than rendering "-3s" for a deployment that started "later".
    seconds = (nowMs - startedMs) / 1000
  } else if (durationSeconds !== null) {
    seconds = durationSeconds
  } else {
    const completedMs = toMillis(completedOn)
    if (startedMs !== null && completedMs !== null) seconds = (completedMs - startedMs) / 1000
  }

  if (seconds === null) return <span className={className}>—</span>

  return (
    <span className={className} title={ticking ? 'Elapsed so far' : 'Total duration'}>
      {formatDuration(seconds)}
    </span>
  )
}
