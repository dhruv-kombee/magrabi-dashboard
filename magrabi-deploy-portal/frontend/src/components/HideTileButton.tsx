import { useState } from 'react'
import type { DeploymentRow } from '../api/types'
import { useHideDeploymentMutation, useUnhideDeploymentMutation } from '../api/hooks'
import styles from './HideTileButton.module.css'

/** Hides one Live Deployments tile for EVERY user, or brings it back.
 *
 * Admin-only, and the page decides that -- this component is simply not rendered for a viewer. The
 * backend re-checks the role on both routes regardless, so a hand-made request gets a 403 rather
 * than relying on the button being absent.
 *
 * This changes what the portal draws and nothing else. The deployment still happened, Azure DevOps
 * is untouched, and the tile comes back the moment someone unhides it.
 */
export function HideTileButton({ row }: { row: DeploymentRow }) {
  const [armed, setArmed] = useState(false)
  const hide = useHideDeploymentMutation()
  const unhide = useUnhideDeploymentMutation()

  // Enough to identify the tile in the stored list later, when the row itself is long gone from the
  // feed window and the key alone would be meaningless.
  const label = [row.pipeline || row.definitionName, row.env, row.releaseName || row.buildNumber]
    .filter(Boolean)
    .join(' / ')

  const busy = hide.isPending || unhide.isPending
  const failed = hide.isError || unhide.isError

  function stop(e: React.MouseEvent) {
    // The whole tile is a button that opens the drawer; hiding must not also open it.
    e.stopPropagation()
  }

  if (row.hidden) {
    return (
      <button
        type="button"
        className={`${styles.button} ${styles.restore} ${failed ? styles.fail : ''}`}
        disabled={busy}
        title="Show this tile again, for everyone"
        onClick={(e) => {
          stop(e)
          unhide.mutate({ id: row.id, project: row.project })
        }}
      >
        {busy ? 'Working…' : failed ? 'Failed' : 'Unhide'}
      </button>
    )
  }

  // Two-step, because the effect is global and invisible to the person it affects: the tile simply
  // stops existing for everyone else, with no notification anywhere.
  if (!armed) {
    return (
      <button
        type="button"
        className={styles.button}
        disabled={busy}
        title="Hide this tile from the board for everyone"
        onClick={(e) => {
          stop(e)
          setArmed(true)
        }}
      >
        Hide
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        className={`${styles.button} ${styles.confirm} ${failed ? styles.fail : ''}`}
        disabled={busy}
        title="Hides it for every user until an admin unhides it"
        onClick={(e) => {
          stop(e)
          hide.mutate(
            { id: row.id, project: row.project, label },
            { onError: () => setArmed(false) },
          )
        }}
      >
        {busy ? 'Hiding…' : failed ? 'Failed — retry' : 'Hide for everyone?'}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={busy}
        onClick={(e) => {
          stop(e)
          setArmed(false)
        }}
      >
        Cancel
      </button>
    </>
  )
}
