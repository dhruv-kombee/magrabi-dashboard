import { useState } from 'react'
import type { MyDeploymentRow } from '../api/types'
import { useCancelDeploymentMutation } from '../api/hooks'
import styles from './CancelButton.module.css'

const TERMINAL_STATUSES = ['succeeded', 'failed', 'rejected', 'canceled', 'approvalTimedOut']

/** Visible any time a deployment this portal triggered hasn't reached a terminal state yet --
 * queued, notStarted, scheduled, awaiting approval, or actively in progress -- so it can be
 * stopped mid-flight, per the explicit ask: "cancel anytime in mid if required." Hidden once
 * something has actually finished (succeeded/failed/rejected/canceled), since there's nothing
 * left to cancel at that point. */
export function CancelButton({ row }: { row: MyDeploymentRow }) {
  const mutation = useCancelDeploymentMutation()
  const [resultLabel, setResultLabel] = useState<string | null>(null)

  if (!row.releaseId || TERMINAL_STATUSES.includes(row.status)) return null

  function handleClick() {
    if (!row.releaseId || !row.env || !row.pipeline) return
    setResultLabel('Canceling...')
    mutation.mutate(
      { releaseId: row.releaseId, env: row.env, pipeline: row.pipeline },
      {
        onSuccess: (data) => setResultLabel(data.ok ? null : `Failed: ${data.message}`),
        onError: (err) => setResultLabel(`Failed: ${(err as Error).message}`),
      },
    )
  }

  if (resultLabel) {
    return <span className={styles.result}>{resultLabel}</span>
  }

  return (
    <button className={styles.button} onClick={handleClick} disabled={mutation.isPending}>
      {mutation.isPending ? 'Canceling...' : 'Cancel'}
    </button>
  )
}
