import { useEffect, useState } from 'react'
import styles from './DeploymentEta.module.css'

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m}m ${String(rest).padStart(2, '0')}s` : `${m}m`
}

/** How much longer this deployment is likely to run, from the median of its own past runs.
 *
 * The estimate is per pipeline AND environment, because the same pipeline takes very different
 * times per stage. It is a median of at least three previous SUCCEEDED deployments -- with less
 * history than that the backend sends null and this renders nothing, which is better than a
 * confident number derived from one sample.
 *
 * Once the elapsed time passes the estimate it stops counting down and reports how far over it is,
 * rather than sitting on "0s" and implying it is about to finish. A deployment that is 3 minutes
 * past its usual time is exactly the one worth looking at.
 */
export function DeploymentEta({
  startedOn,
  etaSeconds,
}: {
  startedOn: string | null
  etaSeconds: number | null
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (!startedOn || !etaSeconds) return null
  const start = new Date(startedOn).getTime()
  if (!Number.isFinite(start)) return null

  const elapsed = (now - start) / 1000
  const remaining = etaSeconds - elapsed

  if (remaining <= 0) {
    return (
      <span className={`${styles.eta} ${styles.over}`} title={`Usually takes about ${fmt(etaSeconds)}`}>
        {fmt(-remaining)} over
      </span>
    )
  }
  return (
    <span
      className={`${styles.eta} ${remaining <= 30 ? styles.soon : ''}`}
      title={`Median of past runs for this pipeline and environment: ${fmt(etaSeconds)}`}
    >
      ~{fmt(remaining)} left
    </span>
  )
}
