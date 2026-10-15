import { useState, type ReactNode } from 'react'
import type { LiveStatusRow } from '../api/types'
import { formatTimestamp } from '../utils/format'
import { SortableTable, type Column } from './SortableTable'
import { useIdentityQuery, usePortalMetaQuery } from '../api/hooks'
import { isVariablesOpen } from '../utils/variablesAccess'
import { EnvVarsModal } from './EnvVarsModal'
import { CommitCell } from './CommitCell'
import styles from './EnvSection.module.css'

/** The per-deployment detail the live-status feed carries on top of the original
 * pipeline/env/release/branch/deployedOn five. Every one of them is optional here on purpose: the
 * backend emits a placeholder row for each environment a pipeline has never successfully deployed
 * to, and those rows have nothing to fill these in with. Treating them as optional keeps the
 * fallbacks below honest instead of rendering "undefined" into the table. */
export type LiveStatusRowFull = LiveStatusRow &
  Partial<{
    releaseId: number | null
    buildNumber: string
    commitId: string
    application: string
    deployedBy: string
    trigger: string
    adoReleaseUrl: string
    adoBuildUrl: string
  }>

const DASH = '-'

/** Renders its content as a link out to ADO, or as plain text when the backend had no URL to give
 * (placeholder rows again) -- an <a> with an empty href would otherwise navigate the SPA back to
 * the current page, which reads as a broken link rather than a missing one. */
function AdoLink({ href, children }: { href?: string; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

/** The order the team actually reads this board in, confirmed 2026-08-21.
 *
 * Alphabetical put `ecom adb2c functionapp` and `ecom cart abandon report function app` above the
 * storefronts, which is the opposite of how anyone uses this page. Everything not named here keeps
 * falling out alphabetically underneath, so adding a pipeline never makes it disappear.
 */
const PIPELINE_PRIORITY = [
  'magrabi storefront',
  'doctor-storefront',
  'drm sanity',
  'magrabi sanity',
  'ecom saleor core',
  'ecom-dashboard',
  'ecom search app',
  'ecom tamara',
  'ecom-checkout-app',
  'ecom-tabby',
  'ecom paymob',
  'macula dashboard',
  'macula batch-processor',
  'macula integrations',
  'macula singlemicro',
]

/** Same normalisation the backend registry uses -- lowercase, and hyphen/underscore/space all
 * treated alike, so `ecom-tabby` and `ecom tabby` cannot rank differently. */
function normPipeline(name: string): string {
  return (name || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim()
}

const PRIORITY_INDEX = new Map(PIPELINE_PRIORITY.map((n, i) => [normPipeline(n), i]))

/** Sort key: priority block first, then alphabetical within whatever is left.
 *
 * Exported so the tile grid orders identically -- the two views of this page showing the same
 * services in two different orders would be its own small bug. */
export function pipelineSortValue(name: string): string {
  const rank = PRIORITY_INDEX.get(normPipeline(name))
  return `${String(rank ?? 900).padStart(3, '0')}|${normPipeline(name)}`
}

// Widths are deliberately conservative: seven columns have to sit inside the table's own wrapper
// without a horizontal scrollbar on a normal laptop, so everything with a bounded value (release,
// build, commit, timestamp) gets a fixed hint and everything free-form (application, pipeline,
// branch) truncates with the full value on hover. Branch stays un-widthed as the one flexible
// column, so it absorbs whatever width is left over rather than the table under-filling the page.
const COLUMNS: Column<LiveStatusRowFull>[] = [
  {
    key: 'application',
    label: 'Application',
    width: '170px',
    truncate: true,
    sortValue: (r) => r.application ?? '',
    title: (r) => r.application ?? '',
    render: (r) => r.application || DASH,
  },
  {
    key: 'pipeline',
    label: 'Pipeline',
    width: '190px',
    truncate: true,
    sortValue: (r) => pipelineSortValue(r.pipeline),
    title: (r) => r.pipeline,
    render: (r) => r.pipeline,
  },
  {
    key: 'release',
    label: 'Release',
    width: '150px',
    truncate: true,
    sortValue: (r) => r.release,
    title: (r) => r.release,
    render: (r) => <AdoLink href={r.adoReleaseUrl}>{r.release}</AdoLink>,
  },
  {
    key: 'branch',
    label: 'Branch',
    truncate: true,
    sortValue: (r) => r.branch,
    title: (r) => r.branch,
    render: (r) => r.branch,
  },
  {
    key: 'buildNumber',
    label: 'Build',
    width: '110px',
    truncate: true,
    sortValue: (r) => r.buildNumber ?? '',
    title: (r) => r.buildNumber ?? '',
    render: (r) => (r.buildNumber ? <AdoLink href={r.adoBuildUrl}>{r.buildNumber}</AdoLink> : DASH),
  },
  {
    key: 'commitId',
    label: 'Commit',
    width: '110px',
    sortValue: (r) => r.commitId ?? '',
    render: (r) => <CommitCell short={r.commitId} full={r.commitFull} />,
  },
  {
    key: 'deployedOn',
    label: 'Last deployed',
    width: '200px',
    sortValue: (r) => r.deployedOn || '',
    render: (r) => (
      <div className={styles.deployedCell}>
        <span>{formatTimestamp(r.deployedOn) || DASH}</span>
        {/* Who triggered it rides along under the timestamp rather than claiming a column of its
            own -- it is the least-scanned field on the page and an eighth column is what tips this
            table into horizontal scrolling. */}
        {r.deployedBy && (
          <span className={styles.deployedBy} title={`Deployed by ${r.deployedBy}`}>
            by {r.deployedBy}
          </span>
        )}
        {/* Shown alongside the person, never instead of them: ADO names a real human as
            requestedFor on automated deployments too, so "by X" alone cannot tell you whether a
            person clicked deploy or a pipeline trigger fired. */}
        {r.trigger === 'automated' && (
          <span
            className={styles.automatedTag}
            title="Triggered automatically by the pipeline, not started by hand"
          >
            automated
          </span>
        )}
      </div>
    ),
  },
]

/** Mirrors _VIEWER_VARIABLES_ENVS in the backend. Admins are not restricted. */
const VIEWER_VARIABLES_ENVS = new Set(['DEV', 'SIT', 'UAT'])

export function EnvSection({ env, rows }: { env: string; rows: LiveStatusRowFull[] }) {
  const isProd = env === 'PROD'
  // Which pipeline's variables are open, if any. Held here rather than per row so only one panel
  // can be up at a time.
  const [varsFor, setVarsFor] = useState<string | null>(null)
  // Presentation only -- the endpoint enforces the same rule server-side.
  const { data: identity } = useIdentityQuery()
  const isAdmin = identity?.role === 'admin'
  // Pipelines every role may read on every environment (Rivoli, Rivoli Sanity).
  const openAliases = usePortalMetaQuery().data?.variablesOpenAliases

  const columns: Column<LiveStatusRowFull>[] = [
    ...COLUMNS,
    {
      key: 'envVars',
      label: '',
      width: '92px',
      // Viewers are refused BETA and PROD by the endpoint, so the button is not offered there --
      // it would open a panel onto a 403. Admins get it everywhere, and so does everyone on an
      // open pipeline.
      render: (r) =>
        isAdmin || VIEWER_VARIABLES_ENVS.has(env) || isVariablesOpen(openAliases, r.pipeline) ? (
          <button
            className={styles.varsButton}
            onClick={() => setVarsFor(r.pipeline)}
            title={`Show the variables configured for ${r.pipeline} ${env}`}
          >
            Variables
          </button>
        ) : null,
    },
  ]

  return (
    <div className={`${styles.section} ${isProd ? styles.prod : ''}`}>
      <h2 className={styles.heading}>
        {env} <span className={styles.count}>({rows.length} pipeline{rows.length === 1 ? '' : 's'})</span>
      </h2>
      <SortableTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.pipeline}
        emptyMessage="No pipelines match."
        defaultSortKey="pipeline"
      />
      {varsFor && (
        <EnvVarsModal pipeline={varsFor} env={env} onClose={() => setVarsFor(null)} />
      )}
    </div>
  )
}
