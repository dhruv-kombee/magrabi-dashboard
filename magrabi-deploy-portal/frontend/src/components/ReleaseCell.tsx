import type { MyDeploymentRow } from '../api/types'
import styles from './ReleaseCell.module.css'

/** Which ADO run a portal row is actually driving.
 *
 * A row names a *registry* pipeline ("batch-processor") and an env, which is not enough to find it
 * in Azure DevOps -- the thing to open there is a numbered release ("Release-156") produced by a
 * named CD definition ("CD-Macula-Batch-Processor"). This cell carries both, linked.
 *
 * Three states, because a run passes through all of them:
 *  - no build yet (the POST has only just gone out): a dash
 *  - building: the CI build number, since no release exists to name yet
 *  - deploying or done: the release name, with the CD definition underneath
 */
export function ReleaseCell({ row }: { row: MyDeploymentRow }) {
  const hasRelease = Boolean(row.releaseName || row.releaseId)
  const primaryLabel = hasRelease
    ? row.releaseName || `Release ${row.releaseId}`
    : row.buildNumber
      ? `Build ${row.buildNumber}`
      : ''
  const primaryHref = hasRelease ? row.releaseUrl : row.buildUrl

  if (!primaryLabel) {
    return <span className={styles.none}>—</span>
  }

  // The CD definition is the answer to "which pipeline is this row deploying", so it stays visible
  // rather than living in a tooltip. Falls back to the build number once a release exists, which
  // is the other identifier someone cross-checking against ADO has in hand.
  const secondary = hasRelease
    ? row.releaseDefinitionName || (row.buildNumber ? `Build ${row.buildNumber}` : '')
    : ''

  return (
    <div className={styles.cell}>
      {primaryHref ? (
        <a className={styles.primary} href={primaryHref} target="_blank" rel="noreferrer">
          {primaryLabel}
        </a>
      ) : (
        <span className={styles.primary}>{primaryLabel}</span>
      )}
      {secondary && (
        <span className={styles.secondary} title={secondary}>
          {secondary}
        </span>
      )}
    </div>
  )
}
