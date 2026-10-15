import type { MyDeploymentRow } from '../api/types'
import { formatTimestamp } from '../utils/format'
import { StatusBadge } from './StatusBadge'
import { ApprovalButton } from './ApprovalButton'
import { ApprovalCountdown } from './ApprovalCountdown'
import { DeploymentEta } from './DeploymentEta'
import { CopyLinkButton, itemForRun } from './CopyTileLink'
import { BatchGroup, buildBlocks } from './BatchGroups'
import { CancelButton } from './CancelButton'
import { DeleteButton } from './DeleteButton'
import { DownloadLogsButton } from './DownloadLogsButton'
import { EditableName } from './EditableName'
import { ReleaseCell } from './ReleaseCell'
import { SortableTable, type Column } from './SortableTable'
import styles from './MyDeploymentsTable.module.css'

/** Which attempt this row is on, shown under the status badge.
 *
 * Prefers Azure DevOps' own numbering so the row reads the same as the release page's
 * "Deployment attempt #2 -- Attempt # 2 of 2". Without it, a row redeploying its second attempt was
 * indistinguishable from one sitting on the first attempt's outcome. Falls back to the portal's own
 * rebuild counter while there is no release yet (during the CI build), and renders nothing at all on
 * a plain first attempt, where "attempt 1" is just noise.
 */
function AttemptLabel({ row }: { row: MyDeploymentRow }) {
  if (row.adoAttempt && row.adoAttemptCount > 1) {
    return (
      <span className={styles.attempt}>
        attempt {row.adoAttempt} of {row.adoAttemptCount}
      </span>
    )
  }
  if (!row.adoAttempt && row.attempt > 1) {
    return <span className={styles.attempt}>attempt {row.attempt}</span>
  }
  return null
}

const COLUMNS: Column<MyDeploymentRow>[] = [
  { key: 'pipeline', label: 'Pipeline', width: '140px', sortValue: (r) => r.pipeline ?? '', render: (r) => r.pipeline ?? '' },
  {
    key: 'branch',
    label: 'Branch',
    // Deliberately NOT the table's `truncate` flag: that ellipsises the whole <td>, which would
    // clip the copy button off the end on a long feature-branch name. A flex row instead lets the
    // text truncate while the button stays pinned beside it and never shrinks.
    width: '1%',
    sortValue: (r) => r.branch ?? '',
    render: (r) => (
      <div className={styles.branchCell}>
        <span className={styles.branchText} title={r.branch ?? ''}>
          {r.branch ?? ''}
        </span>
        <CopyLinkButton items={[itemForRun(r)]} />
      </div>
    ),
  },
  { key: 'env', label: 'Env', width: '60px', render: (r) => r.env ?? '' },
  {
    key: 'release',
    label: 'Release / Build',
    width: '190px',
    // Sorts on the release NAME rather than the id so the column orders the way it reads. Rows
    // with no release yet sort together under their build number.
    sortValue: (r) => r.releaseName || r.buildNumber || '',
    render: (r) => <ReleaseCell row={r} />,
  },
  {
    key: 'requestedBy',
    label: 'Name',
    width: '110px',
    sortValue: (r) => r.requestedBy ?? '',
    render: (r) => <EditableName runId={r.runId} value={r.requestedBy} />,
  },
  {
    key: 'startedAt',
    label: 'Started',
    width: '140px',
    sortValue: (r) => r.startedAt ?? '',
    render: (r) => formatTimestamp(r.startedAt),
  },
  {
    key: 'status',
    label: 'Status',
    width: '220px',
    render: (r) => (
      <div className={styles.statusCell}>
        <StatusBadge status={r.status} />
        <AttemptLabel row={r} />
        {/* Only rendered while the gate is genuinely open; approvalDeadline is null otherwise. */}
        {(r.status === 'pendingApproval' || r.approvalStatus === 'pending') && (
          <ApprovalCountdown deadline={r.approvalDeadline} />
        )}
        {r.status === 'failed' && r.failureReason && (
          <span className={styles.failureReason} title={r.failureReason}>
            {r.failureReason}
          </span>
        )}
      </div>
    ),
  },
  {
    key: 'eta',
    label: 'ETA',
    width: '96px',
    // Only meaningful while something is actually running -- a finished row has no time left, and
    // a row parked on an approval gate is not consuming deploy time at all, so an estimate there
    // would tick down against a clock that has not started.
    render: (r) =>
      r.status === 'inProgress' ? (
        <DeploymentEta startedOn={r.deployStartedOn} etaSeconds={r.etaSeconds} />
      ) : null,
  },
  {
    key: 'approvalStatus',
    label: 'Approval',
    width: '105px',
    // approvalNote carries ADO's own explanation for an auto-reject ("This approval was rejected
    // because of timeout 1 minute(s)"), which is the difference between "someone said no" and
    // "nobody looked in time".
    render: (r) =>
      r.approvalStatus ? (
        <StatusBadge status={r.approvalStatus} title={r.approvalNote || undefined} />
      ) : (
        '-'
      ),
  },
  {
    key: 'action',
    label: '',
    width: '240px',
    // Wraps as whole buttons (see .actionCell) instead of one bare inline row -- at up to 4
    // buttons for a failed+redeployable row, a single-line row was overflowing and a strict
    // single column was making every row as tall as 4 stacked buttons even when other columns
    // only needed one line. Wrapping settles at ~2 lines for the common cases.
    render: (r) => (
      <div className={styles.actionCell}>
        <CancelButton row={r} />
        <DownloadLogsButton row={r} />
        <ApprovalButton row={r} />
        <DeleteButton row={r} />
      </div>
    ),
  },
]

function Table({ rows, emptyMessage }: { rows: MyDeploymentRow[]; emptyMessage: string }) {
  return (
    <SortableTable
      columns={COLUMNS}
      rows={rows}
      // runId, not pipeline+env+startedAt: a rebuild now reuses its row and moves its start time,
      // which under the old key looked like a different row to React -- remounting it and
      // discarding the button state that reports what the click did.
      getRowKey={(r) => r.runId}
      emptyMessage={emptyMessage}
      defaultSortKey="startedAt"
      defaultSortDir={-1}
    />
  )
}

/** Deployments submitted together in one paste render inside their own box, so it is obvious at a
 * glance that they were one request rather than several unrelated ones. Everything else falls
 * through to a single table below them. */
export function MyDeploymentsTable({
  rows,
  emptyMessage = 'No deployments started yet.',
}: {
  rows: MyDeploymentRow[]
  emptyMessage?: string
}) {
  const blocks = buildBlocks(rows)
  if (blocks.length === 0) return <Table rows={[]} emptyMessage={emptyMessage} />
  return (
    <>
      {blocks.map((b) =>
        b.kind === 'batch' ? (
          <BatchGroup key={b.key} rows={b.rows}>
            <Table rows={b.rows} emptyMessage={emptyMessage} />
          </BatchGroup>
        ) : (
          <Table key={b.key} rows={b.rows} emptyMessage={emptyMessage} />
        ),
      )}
    </>
  )
}
