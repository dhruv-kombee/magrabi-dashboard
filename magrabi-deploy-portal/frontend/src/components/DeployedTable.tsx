import type { MyDeploymentRow } from '../api/types'
import { formatTimestamp } from '../utils/format'
import { RedeployAgainButton } from './RedeployAgainButton'
import { CopyLinkButton, itemForRun } from './CopyTileLink'
import { BatchGroup, buildBlocks } from './BatchGroups'
import { EditableName } from './EditableName'
import { ReleaseCell } from './ReleaseCell'
import { SortableTable, type Column } from './SortableTable'
import styles from './MyDeploymentsTable.module.css'

// Deliberately fewer columns than MyDeploymentsTable -- everything here has already succeeded, so
// Approval/Cancel/Logs columns have nothing left to show or do. The one action that still makes
// sense is running it again. Sorted newest-first by default, so a row that just finished lands at
// the top of this list the moment it moves here.
const COLUMNS: Column<MyDeploymentRow>[] = [
  { key: 'pipeline', label: 'Pipeline', width: '130px', sortValue: (r) => r.pipeline ?? '', render: (r) => r.pipeline ?? '' },
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
    label: 'Deployed',
    width: '140px',
    sortValue: (r) => r.startedAt ?? '',
    render: (r) => formatTimestamp(r.startedAt),
  },
  {
    key: 'action',
    label: '',
    width: '240px',
    render: (r) => (
      <div className={styles.actionCell}>
        <RedeployAgainButton row={r} />
      </div>
    ),
  },
]

function Table({ rows }: { rows: MyDeploymentRow[] }) {
  return (
    <SortableTable
      columns={COLUMNS}
      rows={rows}
      // Same reasoning as MyDeploymentsTable: runId survives an in-place rebuild, the old
      // composite key did not.
      getRowKey={(r) => r.runId}
      emptyMessage="Nothing deployed yet."
      defaultSortKey="startedAt"
      defaultSortDir={-1}
    />
  )
}

/** Same batching as the ongoing table: a set of deployments requested together stays visibly
 * together after they finish, which is what makes the "all four are done" Teams update easy to
 * assemble -- the group's Copy all button emits one line per deployment. */
export function DeployedTable({ rows }: { rows: MyDeploymentRow[] }) {
  const blocks = buildBlocks(rows)
  if (blocks.length === 0) return <Table rows={[]} />
  return (
    <>
      {blocks.map((b) =>
        b.kind === 'batch' ? (
          <BatchGroup key={b.key} rows={b.rows}>
            <Table rows={b.rows} />
          </BatchGroup>
        ) : (
          <Table key={b.key} rows={b.rows} />
        ),
      )}
    </>
  )
}
