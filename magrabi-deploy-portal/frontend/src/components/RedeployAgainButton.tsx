import { useEffect, useRef, useState } from 'react'
import type { MyDeploymentRow } from '../api/types'
import { useRebuildDeployMutation } from '../api/hooks'
import styles from './RedeployAgainButton.module.css'

// How long the armed "Confirm?" state stays up before reverting on its own.
const CONFIRM_TIMEOUT_MS = 4000

/** Re-runs a deployment that already succeeded: fresh CI build off the same branch, then deploy
 * and approve -- the same full chain the failed-row rebuild uses, not a replay of the old artifact.
 *
 * Deliberately two-click. Every other action in this app sits next to something visibly wrong, so
 * an accidental click is at worst a retry of something already broken. This one lives in the
 * "Deployed" list where every row is finished and healthy, and a stray click would queue a real
 * build and push it to a live lower environment -- cheap to guard, annoying to undo.
 */
export function RedeployAgainButton({ row }: { row: MyDeploymentRow }) {
  const mutation = useRebuildDeployMutation()
  const [armed, setArmed] = useState(false)
  const [resultLabel, setResultLabel] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Disarm on a timer so a half-pressed button never sits there indefinitely waiting to fire.
  useEffect(() => {
    if (!armed) return
    timerRef.current = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [armed])

  if (!row.pipeline || !row.branch || !row.env) return null

  function handleClick() {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setIsError(false)
    setResultLabel('Queueing...')
    mutation.mutate(
      {
        pipeline: row.pipeline as string,
        branch: row.branch as string,
        env: row.env as string,
        // In place, same as the failed-row rebuild -- this row moves back to Ongoing and tracks
        // the new attempt, rather than leaving a stale "deployed" twin behind.
        runId: row.runId,
      },
      {
        onSuccess: (data) => {
          setIsError(!data.ok)
          setResultLabel(data.ok ? 'Build queued' : `Failed: ${data.message}`)
        },
        onError: (err) => {
          setIsError(true)
          setResultLabel(`Failed: ${(err as Error).message}`)
        },
      },
    )
  }

  const className = [styles.button, armed && styles.armed, isError && styles.error]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      className={className}
      onClick={handleClick}
      disabled={mutation.isPending}
      title={
        armed
          ? 'Click again to confirm'
          : `Rebuild ${row.branch} and deploy it to ${row.env} again, then approve`
      }
    >
      {resultLabel ?? (armed ? 'Confirm rebuild?' : 'Redeploy once again')}
    </button>
  )
}
