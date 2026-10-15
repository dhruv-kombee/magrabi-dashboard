import { useState } from 'react'
import type { MyDeploymentRow } from '../api/types'
import { useRebuildDeployMutation, useRedeployApproveMutation } from '../api/hooks'
import styles from './ApprovalButton.module.css'

// Azure DevOps has already taken the deployment: it is running, or accepted and on its way. There
// is nothing left for a human to trigger or approve from here -- the environment proceeds on its
// own (through its approval gate if it has one). Note "notStarted" is deliberately NOT here: that
// is the state where the environment really is parked waiting for someone, and the approve action
// is the whole point.
const IN_FLIGHT_STATUSES = ['inProgress', 'queued', 'scheduled']
// A finished-but-unsuccessful run is the only case where rebuilding from source is meaningful:
// everything else either has not produced an artifact yet or already deployed one successfully.
// approvalTimedOut belongs here too -- an approval that expired is precisely a run you want to
// start again, and leaving it out would have hidden every action on those rows.
const RETRYABLE_STATUSES = ['rejected', 'failed', 'canceled', 'approvalTimedOut']

/** What to say about a deployment ADO has already accepted.
 *
 * "Deploying..." is only honest once it is actually running. A queued environment has not started
 * yet -- it is waiting its turn (and will pass its approval gate on the way) -- so it says it will
 * deploy rather than claiming it already is. */
function inFlightLabel(row: MyDeploymentRow): string {
  if (row.status === 'inProgress') return 'Deploying...'
  if (row.status === 'scheduled') return 'Scheduled'
  return row.approvalStatus === 'approved' ? 'Approved - will deploy' : 'Queued - will deploy'
}

export function ApprovalButton({ row }: { row: MyDeploymentRow }) {
  const mutation = useRedeployApproveMutation()
  const rebuild = useRebuildDeployMutation()
  const [rebuildLabel, setRebuildLabel] = useState<string | null>(null)
  const [rebuildError, setRebuildError] = useState(false)
  const [resultLabel, setResultLabel] = useState<string | null>(null)
  // Failure is tracked as its own flag rather than being read back out of resultLabel. The label is
  // a display string; inferring control flow from its prefix means any wording change silently
  // takes the error styling with it.
  const [isError, setIsError] = useState(false)

  if (row.status === 'succeeded') {
    return <span className={styles.done}>Deployed</span>
  }

  // A pending pre-deploy approval is checked BEFORE the in-flight test below, and this ordering is
  // the whole fix. ADO reports a stage parked on its approval gate as env.status "inProgress"
  // (verified live 2026-08-17, releases 8649/8651), so the in-flight branch used to swallow it:
  // the row said "Deploying...", no approve button rendered, and the gate auto-rejected ~60s later.
  // The one state that must never be treated as in flight is the one waiting on this button.
  const awaitingApproval = row.status === 'pendingApproval' || row.approvalStatus === 'pending'

  // Anything ADO has already accepted gets a non-clickable indicator instead of a button that looks
  // actionable but isn't.
  //
  // This used to require approvalStatus === 'approved' as well, which left a real hole: a QUEUED
  // environment has no approval RECORD yet (verified live on release 8580/env 28195 --
  // preDeployApprovals was an empty list while preApprovalsSnapshot showed the gate configured), so
  // approvalStatus is null and the row fell through to a live "Trigger & Approve" button for a
  // deployment that was already on its way.
  if (!awaitingApproval && IN_FLIGHT_STATUSES.includes(row.status)) {
    return (
      <>
        <span className={styles.deploying}>{inFlightLabel(row)}</span>
        {row.approvalUrl && (
          <a className={styles.link} href={row.approvalUrl} target="_blank" rel="noreferrer">
            Open in ADO
          </a>
        )}
      </>
    )
  }

  if (!row.releaseId) return null

  const canRebuild = RETRYABLE_STATUSES.includes(row.status) && Boolean(row.branch) && Boolean(row.pipeline)
  // When rebuilding is on offer, the plain retrigger is demoted and renamed. The old label said
  // "Redeploy & Approve", which read as though it rebuilt -- it does not, it redeploys the SAME
  // artifact, so on a build failure it just reproduces the identical failure. Naming it for what
  // it actually does keeps the fast path available (right for an agent/timeout blip) without
  // implying it will pick up new code.
  // "Approve now" when the gate is genuinely open: the deployment is already triggered and waiting,
  // so "Trigger & Approve" would misdescribe what the click does -- and the ~60s ADO timeout means
  // the wording needs to read as urgent rather than as starting something new.
  const label = awaitingApproval
    ? 'Approve now'
    : canRebuild
      ? 'Redeploy same build'
      : 'Trigger & Approve'

  function handleRebuild() {
    if (!row.pipeline || !row.branch || !row.env) return
    setRebuildError(false)
    setRebuildLabel('Queueing build...')
    // runId makes this a rebuild OF THIS ROW: the backend rewrites this run rather than opening a
    // second one, so the row updates in place instead of a duplicate appearing above it.
    rebuild.mutate(
      { pipeline: row.pipeline, branch: row.branch, env: row.env, runId: row.runId },
      {
        onSuccess: (data) => {
          setRebuildError(!data.ok)
          setRebuildLabel(data.ok ? 'Build queued' : `Failed: ${data.message}`)
        },
        onError: (err) => {
          setRebuildError(true)
          setRebuildLabel(`Failed: ${(err as Error).message}`)
        },
      },
    )
  }

  function handleClick() {
    if (!row.releaseId || !row.env || !row.pipeline) return
    // Clear any previous failure before the retry, otherwise the button stays red while it works.
    setIsError(false)
    setResultLabel('Working...')
    mutation.mutate(
      { releaseId: row.releaseId, env: row.env, pipeline: row.pipeline },
      {
        onSuccess: (data) => {
          setIsError(!data.ok)
          setResultLabel(data.ok ? 'Approved' : `Failed: ${data.message}`)
        },
        onError: (err) => {
          setIsError(true)
          setResultLabel(`Failed: ${(err as Error).message}`)
        },
      },
    )
  }

  return (
    <>
      {/* Primary action for a failed run: fresh CI build off the same branch, then deploy and
          approve. This is what actually picks up a code fix. */}
      {canRebuild && (
        <button
          className={`${styles.button} ${rebuildError ? styles.errorButton : ''}`}
          onClick={handleRebuild}
          disabled={rebuild.isPending}
          title={`Queue a new CI build of ${row.branch}, then deploy to ${row.env} and approve`}
        >
          {rebuildLabel ?? 'Rebuild & Deploy'}
        </button>
      )}
      <button
        className={`${styles.button} ${canRebuild ? styles.secondaryButton : ''} ${isError ? styles.errorButton : ''}`}
        onClick={handleClick}
        disabled={mutation.isPending}
        title={
          canRebuild
            ? 'Re-run the deployment using the build that already exists -- does not pick up new code'
            : undefined
        }
      >
        {resultLabel ?? label}
      </button>
      {row.approvalUrl && (
        <a className={styles.link} href={row.approvalUrl} target="_blank" rel="noreferrer">
          Open in ADO
        </a>
      )}
    </>
  )
}
