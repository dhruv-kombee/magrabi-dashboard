import { useState } from 'react'
import type { MyDeploymentRow } from '../api/types'
import { useDismissDeploymentMutation } from '../api/hooks'
import styles from './DeleteButton.module.css'

// Terminal states the user is allowed to clear off the list. Mirrors DISMISSABLE_STATUSES in the
// backend, which re-checks this independently -- a canceled run is just as much dead noise as a
// failed one, while anything live or succeeded stays put.
const DISMISSABLE_STATUSES = ['failed', 'canceled']

/** Only ever shown for a terminally dead row -- lets the user clear noise out of the ongoing
 * list without touching ADO at all (this just deletes the portal's local bookkeeping file). The
 * backend re-checks the row's live status before deleting, so a stale click on a row that has
 * since recovered (e.g. a redeploy succeeded) is refused rather than silently discarding it. */
export function DeleteButton({ row }: { row: MyDeploymentRow }) {
  const mutation = useDismissDeploymentMutation()
  const [errorLabel, setErrorLabel] = useState<string | null>(null)

  if (!DISMISSABLE_STATUSES.includes(row.status)) return null

  function handleClick() {
    setErrorLabel(null)
    mutation.mutate(
      { runId: row.runId },
      {
        onSuccess: (data) => {
          if (!data.ok) setErrorLabel(data.message)
        },
        onError: (err) => setErrorLabel((err as Error).message),
      },
    )
  }

  return (
    <>
      <button
        className={styles.button}
        onClick={handleClick}
        disabled={mutation.isPending}
        title={`Remove this ${row.status} run from the list (does not affect Azure DevOps)`}
        aria-label={`Remove this ${row.status} run`}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {errorLabel && <span className={styles.error}>{errorLabel}</span>}
    </>
  )
}
