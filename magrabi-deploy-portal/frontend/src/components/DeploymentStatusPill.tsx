import styles from './DeploymentStatusPill.module.css'

/** The normalized statuses the backend emits (it owns the ADO deploymentStatus/operationStatus ->
 * status mapping; nothing here re-derives it) paired with the wording a human should read. Anything
 * unrecognised falls through to a neutral pill showing the raw string rather than being hidden. */
export const STATUS_LABELS: Record<string, string> = {
  succeeded: 'Succeeded',
  inProgress: 'In progress',
  building: 'Building',
  failed: 'Failed',
  canceled: 'Canceled',
  queued: 'Queued',
  waiting: 'Waiting',
  rejected: 'Rejected',
  notDeployed: 'Not deployed',
}

const TONE_BY_STATUS: Record<string, string> = {
  succeeded: 'succeeded',
  inProgress: 'inProgress',
  building: 'queued',
  failed: 'failed',
  canceled: 'canceled',
  queued: 'queued',
  waiting: 'waiting',
  rejected: 'rejected',
  notDeployed: 'notDeployed',
}

// `as const` matters: without it TypeScript widens strokeLinecap to `string`, which is not
// assignable to the SVG attribute union when this is spread onto an element.
const ICON_PROPS = {
  viewBox: '0 0 12 12',
  width: 12,
  height: 12,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
} as const

function StatusGlyph({ status }: { status: string }) {
  switch (status) {
    case 'inProgress':
      // A bordered circle rather than a stroked SVG path: this one has to spin forever, and
      // animating a border is dramatically cheaper for the compositor than animating geometry.
      return <span className={styles.spinner} aria-hidden="true" />
    case 'succeeded':
      return (
        <svg {...ICON_PROPS} className={styles.icon}>
          <polyline points="2.4,6.4 4.9,8.9 9.6,3.4" />
        </svg>
      )
    case 'failed':
      return (
        <svg {...ICON_PROPS} className={styles.icon}>
          <path d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8" />
        </svg>
      )
    case 'rejected':
      return (
        <svg {...ICON_PROPS} className={styles.icon}>
          <circle cx="6" cy="6" r="4.1" />
          <path d="M3.7 6 H8.3" />
        </svg>
      )
    case 'canceled':
      return (
        <svg {...ICON_PROPS} className={styles.icon}>
          <circle cx="6" cy="6" r="4.1" />
          <path d="M3.1 8.9 L8.9 3.1" />
        </svg>
      )
    case 'waiting':
      return (
        <svg {...ICON_PROPS} className={styles.icon}>
          <path d="M4.6 3.2 V8.8 M7.4 3.2 V8.8" />
        </svg>
      )
    case 'queued':
      // Three dots drawn as zero-length round-capped segments -- an ellipsis reads as "lined up
      // behind something" far better than any single glyph.
      return (
        <svg {...ICON_PROPS} className={styles.icon} strokeWidth={2.4}>
          <path d="M2.6 6 h0.01 M6 6 h0.01 M9.4 6 h0.01" />
        </svg>
      )
    case 'notDeployed':
      return (
        <svg {...ICON_PROPS} className={styles.icon}>
          <circle cx="6" cy="6" r="4.1" strokeDasharray="1.8 2.2" />
        </svg>
      )
    default:
      return (
        <svg {...ICON_PROPS} className={styles.icon}>
          <circle cx="6" cy="6" r="4.1" />
        </svg>
      )
  }
}

export function DeploymentStatusPill({ status }: { status: string }) {
  const tone = TONE_BY_STATUS[status] ?? 'unknown'
  const label = STATUS_LABELS[status] ?? (status || 'Unknown')

  return (
    <span className={`${styles.pill} ${styles[tone]}`} title={`Status: ${label}`}>
      <StatusGlyph status={status} />
      <span className={styles.label}>{label}</span>
    </span>
  )
}
