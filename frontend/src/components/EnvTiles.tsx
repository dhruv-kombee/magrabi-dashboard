import { useMemo, useState } from 'react'
import { useIdentityQuery, usePortalMetaQuery } from '../api/hooks'
import { isVariablesOpen } from '../utils/variablesAccess'
import { formatTimestamp } from '../utils/format'
import { EnvVarsModal } from './EnvVarsModal'
import { pipelineSortValue, type LiveStatusRowFull } from './EnvSection'
import {
  applicationIsRedundant,
  tileGroup,
  tileTone,
  type TileGroup,
} from './tileTaxonomy'
import styles from './EnvTiles.module.css'

const DASH = '-'

/** Mirrors _VIEWER_VARIABLES_ENVS in the backend, and EnvSection's copy of the same rule. */
const VIEWER_VARIABLES_ENVS = new Set(['DEV', 'SIT', 'UAT'])

/** A pipeline that has never successfully deployed to this environment.
 *
 * The backend emits a placeholder row for every pipeline x environment pair, so these arrive with
 * no release, branch or timestamp rather than not arriving at all. */
function neverDeployed(row: LiveStatusRowFull): boolean {
  return !row.release && !row.branch && !row.deployedOn
}

const GROUP_LABEL: Record<TileGroup, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
}

/** Copies the full 40-character SHA in one click.
 *
 * No "Commit" label anywhere near it: on a card this size the hash is self-evidently a hash, and the
 * label cost a line that the branch needed more. The short hash IS the button — clicking it puts the
 * full SHA on the clipboard and the chip says "Copied" for a moment. The label swaps rather than
 * showing a toast, because on a grid of 30+ tiles a floating toast cannot say which tile it came from.
 *
 * Falls back to the short hash when the backend had no full SHA (placeholder rows), so the button
 * never silently copies an empty string.
 */
function CopySha({ short, full }: { short?: string; full?: string }) {
  const [copied, setCopied] = useState(false)
  const value = full || short || ''

  if (!short) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard blocked (insecure context, or permission denied). The hash is still on screen
         and selectable, so this degrades to "read it off the tile" rather than to nothing. */
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className={`${styles.sha} ${copied ? styles.shaCopied : ''}`}
      onClick={() => void copy()}
      title={full ? `Click to copy the full commit SHA\n${full}` : 'Click to copy this commit'}
    >
      <code>{copied ? 'Copied' : short}</code>
    </button>
  )
}

/** One pipeline in one environment. */
function Tile({
  row,
  env,
  canSeeVars,
  onOpenVars,
}: {
  row: LiveStatusRowFull
  env: string
  canSeeVars: boolean
  onOpenVars: () => void
}) {
  // Dimming the tile says "nothing here" without removing it -- the absence is itself information
  // ("this service has never reached UAT").
  const never = neverDeployed(row)
  const tone = tileTone(row.pipeline)
  const showApplication = !applicationIsRedundant(row.pipeline, row.application)

  return (
    <article
      className={`${styles.tile} ${styles[tone]} ${never ? styles.tileEmpty : ''}`}
      data-tone={tone}
    >
      {/* Tinted band, while the body below stays on the neutral surface. Colour identity where it
          is scanned for, full contrast where things are actually read. */}
      <header className={styles.head}>
        {/* Carries the category in shape as well as hue, so the grouping survives a colour-blind
            reader and a greyscale screenshot. */}
        <span className={styles.dot} aria-hidden="true" />
        <div className={styles.names}>
          <h3 className={styles.pipeline} title={row.pipeline}>
            {row.pipeline}
          </h3>
          {/* Only when it actually says something the heading did not -- see applicationIsRedundant. */}
          {showApplication && (
            <span className={styles.application} title={row.application}>
              {row.application}
            </span>
          )}
        </div>
      </header>

      <div className={styles.body}>
      <div className={styles.branchRow}>
        <span className={styles.label}>Branch</span>
        {/* The full branch name in the tooltip: these run to 60+ characters
            ("kanika/feature/MLC-2067_Configure-Sentry-Crash-Error-Monitoring-for-Saleor-Apps") and
            the tail is the part that identifies it, so truncation alone would not be enough. */}
        <span className={styles.branch} title={row.branch || undefined}>
          {row.branch || DASH}
        </span>
      </div>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Release</dt>
          <dd>
            {row.release ? (
              row.adoReleaseUrl ? (
                <a className={styles.link} href={row.adoReleaseUrl} target="_blank" rel="noreferrer">
                  {row.release}
                </a>
              ) : (
                row.release
              )
            ) : (
              DASH
            )}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>Build</dt>
          <dd>
            {row.buildNumber ? (
              row.adoBuildUrl ? (
                <a className={styles.link} href={row.adoBuildUrl} target="_blank" rel="noreferrer">
                  {row.buildNumber}
                </a>
              ) : (
                row.buildNumber
              )
            ) : (
              DASH
            )}
          </dd>
        </div>
      </dl>
      </div>

      {/* Deployed-by is deliberately NOT here. ADO names a real person as requestedFor on automated
          deployments too, so the name was answering a question nobody asked and taking the room the
          commit chip now uses. */}
      <footer className={styles.foot}>
        <span className={styles.when}>{formatTimestamp(row.deployedOn) || 'never deployed'}</span>
        <div className={styles.actions}>
          <CopySha short={row.commitId} full={row.commitFull} />
          {canSeeVars && (
            <button
              type="button"
              className={styles.varsButton}
              onClick={onOpenVars}
              title={`Show the variables configured for ${row.pipeline} ${env}`}
            >
              Variables
            </button>
          )}
        </div>
      </footer>
    </article>
  )
}

/** The tile grid for one environment, split into Frontend and Backend.
 *
 * Exists alongside EnvSection's table rather than replacing it: the table is what gets shared into
 * Teams as the "has it reached PROD yet" board, where a dense sortable list is the right shape. The
 * grid answers the other question -- "what is this environment running right now" -- where one card
 * per service, scannable side by side, beats a row you have to track across seven columns.
 */
export function EnvTiles({ env, rows }: { env: string; rows: LiveStatusRowFull[] }) {
  const isProd = env === 'PROD'
  // One panel at a time, held here rather than per tile.
  const [varsFor, setVarsFor] = useState<string | null>(null)
  // Presentation only -- the endpoint enforces the same rule server-side.
  const { data: identity } = useIdentityQuery()
  const isAdmin = identity?.role === 'admin'
  const openAliases = usePortalMetaQuery().data?.variablesOpenAliases

  // The table's default sort, applied here too: the storefronts first, then the rest alphabetically.
  // The feed's own order is by registry position, which puts adb2c function apps above the sites.
  const groups = useMemo(() => {
    // Deployed first, never-deployed last, each block in the table's own reading order. Mixed in,
    // the empty placeholders broke the scan down the grid for no benefit -- "what is running here"
    // is the question, and the ones running should not be interrupted by ones that never have.
    const sorted = [...rows].sort((a, b) => {
      const byState = Number(neverDeployed(a)) - Number(neverDeployed(b))
      if (byState !== 0) return byState
      return pipelineSortValue(a.pipeline).localeCompare(pipelineSortValue(b.pipeline))
    })
    // Fixed order, not derived: Frontend always leads, because that is what gets asked about.
    return (['frontend', 'backend'] as TileGroup[])
      .map((g) => ({ group: g, items: sorted.filter((r) => tileGroup(r.pipeline) === g) }))
      .filter((g) => g.items.length > 0)
  }, [rows])

  return (
    <section className={`${styles.wrap} ${isProd ? styles.prod : ''}`}>
      <h2 className={styles.heading}>
        {env}{' '}
        <span className={styles.count}>
          ({rows.length} pipeline{rows.length === 1 ? '' : 's'})
        </span>
      </h2>

      {groups.length === 0 ? (
        <p className={styles.empty}>No pipelines match.</p>
      ) : (
        groups.map(({ group, items }) => (
          <div key={group} className={styles.groupBlock}>
            {/* A full-width bar, not a small heading: with 30+ cards on screen the boundary between
                Frontend and Backend has to survive being scrolled past. */}
            <div className={`${styles.groupBar} ${styles[`bar_${group}`]}`}>
              <span className={styles.groupName}>{GROUP_LABEL[group]}</span>
              <span className={styles.groupCount}>
                {items.length} service{items.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className={styles.grid}>
              {items.map((row) => (
                <Tile
                  key={row.pipeline}
                  row={row}
                  env={env}
                  canSeeVars={
                    isAdmin ||
                    VIEWER_VARIABLES_ENVS.has(env) ||
                    isVariablesOpen(openAliases, row.pipeline)
                  }
                  onOpenVars={() => setVarsFor(row.pipeline)}
                />
              ))}
            </div>
          </div>
        ))
      )}
      {varsFor && <EnvVarsModal pipeline={varsFor} env={env} onClose={() => setVarsFor(null)} />}
    </section>
  )
}
