import styles from './AdoUnreachableBanner.module.css'

function sinceText(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Shown when the portal cannot reach Azure DevOps.
 *
 * This exists because of a real incident: egress from the cluster to the Azure DevOps address range
 * started timing out while the rest of the internet stayed fine. Every board silently showed zeros
 * and rows frozen days earlier, which reads as "nothing is deploying" rather than "I cannot see".
 * Someone triggered a deployment, could not find it, and reasonably concluded the portal was broken.
 *
 * An empty board only means nothing is happening if the portal was able to look.
 */
export function AdoUnreachableBanner({
  reachable,
  error,
  failedSince,
}: {
  reachable?: boolean
  error?: string | null
  failedSince?: string | null
}) {
  if (reachable !== false) return null
  const since = sinceText(failedSince)
  return (
    <div className={styles.banner} role="alert">
      <strong className={styles.title}>
        The portal cannot reach Azure DevOps{since ? ` — since ${since}` : ''}
      </strong>
      <p className={styles.body}>
        Everything below is frozen at whatever was last seen. Rows will not advance, a deployment
        started now will not appear, and an empty board does not mean nothing is running. Check
        Azure DevOps directly until this clears.
      </p>
      <p className={styles.body}>
        This is a network problem between the cluster and Azure DevOps, not something a refresh
        fixes. If it persists, it needs someone with access to the cluster egress rules.
      </p>
      {error && <code className={styles.detail}>{error}</code>}
    </div>
  )
}
