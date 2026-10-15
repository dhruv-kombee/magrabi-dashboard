import styles from './StatusBadge.module.css'

const COLOR_BY_STATUS: Record<string, keyof typeof styles> = {
  succeeded: 'green',
  approved: 'green',
  failed: 'red',
  rejected: 'red',
  canceled: 'red',
  inprogress: 'amber',
  queued: 'amber',
  notstarted: 'amber',
  scheduled: 'amber',
  building: 'amber',
  creatingrelease: 'amber',
  // Phases the deploy worker reports between "build finished" and "ADO owns it now". Without
  // these they fell through to grey, which read as an unknown/stalled state rather than progress.
  deploying: 'amber',
  rebuilding: 'amber',
  partiallysucceeded: 'amber',
  // An approval nobody actioned in time. Not a failure of the deployment and not a refusal by a
  // person, so it gets its own colour rather than borrowing FAILED's red.
  approvaltimedout: 'amber',
  timedout: 'amber',
  notdeployed: 'gray',
  readyforapproval: 'blue',
  pending: 'blue',
  // Parked on a pre-deploy approval. Blue like the other "waiting on a person" states rather than
  // amber: amber reads as "the system is working on it", and here nothing moves until someone acts.
  pendingapproval: 'blue',
}

/** Statuses whose raw API spelling reads badly in a badge. Anything not listed is shown verbatim,
 * which is right for the ones that already match what Azure DevOps itself displays. */
const LABEL_BY_STATUS: Record<string, string> = {
  approvaltimedout: 'approval timed out',
  timedout: 'timed out',
  notdeployed: 'not deployed',
  readyforapproval: 'ready for approval',
  creatingrelease: 'creating release',
  // Deliberately not "pending approval": this says who has to move, which is the whole point of
  // separating it from ADO's own "inProgress" for the same stage.
  pendingapproval: 'awaiting approval',
}

export function StatusBadge({ status, title }: { status: string | null | undefined; title?: string }) {
  const label = status || 'unknown'
  const key = label.toLowerCase().replace(/[^a-z]/g, '')
  const color = COLOR_BY_STATUS[key] ?? 'gray'
  return (
    <span className={`${styles.badge} ${styles[color]}`} title={title}>
      {LABEL_BY_STATUS[key] ?? label}
    </span>
  )
}
