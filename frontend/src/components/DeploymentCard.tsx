import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { DeploymentRow } from '../api/types'
import { allLogsUrl, failedSectionLogsUrl } from '../api/client'
import { formatTimestamp } from '../utils/format'
import { DeploymentStatusPill } from './DeploymentStatusPill'
import { CopyTileLink } from './CopyTileLink'
import { HideTileButton } from './HideTileButton'
import { LiveDuration } from './LiveDuration'
import styles from './DeploymentCard.module.css'

// Each status paints the card's left edge. The class only sets a custom property, so the accent
// bar, the focus ring and the stuck treatment all read the one value instead of each restating it.
const ACCENT_CLASS: Record<string, string> = {
  succeeded: 'accentSucceeded',
  failed: 'accentFailed',
  inProgress: 'accentInProgress',
  building: 'accentInProgress',
  queued: 'accentQueued',
  waiting: 'accentWaiting',
  canceled: 'accentCanceled',
  rejected: 'accentRejected',
  notDeployed: 'accentNotDeployed',
}

const ENV_CLASS: Record<string, string> = {
  PROD: 'envProd',
  UAT: 'envUat',
  SIT: 'envSit',
  DEV: 'envDev',
}

// The entrance stagger stops growing after this many cards: on a 200-row feed a per-index delay
// would still be animating rows in half a minute after the data landed.
const MAX_STAGGER_STEPS = 10
const STAGGER_STEP_MS = 45

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const shown = value.trim()
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={mono ? `${styles.fieldValue} ${styles.mono}` : styles.fieldValue} title={shown || undefined}>
        {shown || '—'}
      </span>
    </div>
  )
}

/** Same visual treatment as ExternalLink, but this one actually pulls the log file down through our
 * own backend rather than sending the user off to Azure DevOps. `download` matters for more than
 * convenience: without it an error response would be rendered in place of the running app, and
 * these two endpoints can legitimately fail (a release whose logs ADO has already aged out). */
function DownloadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className={styles.link}
      href={href}
      download
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      <svg
        className={styles.linkIcon}
        viewBox="0 0 10 10"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M5 1v5.4M2.8 4.4L5 6.6l2.2-2.2M1.6 8.6h6.8" />
      </svg>
    </a>
  )
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!href) return null
  return (
    <a
      className={styles.link}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Without this the click keeps bubbling to the card and opens the detail drawer behind the
      // tab the browser just opened.
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      <svg
        className={styles.linkIcon}
        viewBox="0 0 10 10"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M3.6 1.4 H8.6 V6.4" />
        <path d="M8.6 1.4 L1.6 8.4" />
      </svg>
    </a>
  )
}

export interface DeploymentCardProps {
  row: DeploymentRow
  index: number
  onOpen: (row: DeploymentRow) => void
  /** Admin only. The page resolves the role once rather than every card asking, and the backend
   * re-checks it on the route, so this is presentation only -- never the authorization. */
  canHide?: boolean
}

export function DeploymentCard({ row, index, onOpen, canHide = false }: DeploymentCardProps) {
  const isRunning = row.status === 'inProgress'
  const accentClass = styles[ACCENT_CLASS[row.status] ?? 'accentNotDeployed']
  const envClass = styles[ENV_CLASS[row.env] ?? 'envOther']
  // releaseId is guarded too: a row that never produced a release has nothing to fetch logs from,
  // and the endpoints would 404 on it.
  const canDownloadLogs = row.status === 'failed' && row.releaseId > 0

  const cardClass = [styles.card, accentClass, isRunning && styles.running, row.isStuck && styles.stuck]
    .filter(Boolean)
    .join(' ')

  // Custom properties are not part of CSSProperties' known keys; the cast is the standard way to
  // hand one to an inline style without reaching for `any`.
  const staggerStyle = {
    '--card-stagger': `${Math.min(index, MAX_STAGGER_STEPS) * STAGGER_STEP_MS}ms`,
  } as CSSProperties

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Enter/Space landing on one of the ADO links inside the card is the link's business. Without
    // this guard the bubbling keypress would also open the drawer behind the new tab.
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen(row)
    }
  }

  return (
    <div className={styles.perspective} style={staggerStyle}>
      <article
        className={cardClass}
        role="button"
        tabIndex={0}
        aria-label={`${row.pipeline} to ${row.env}, ${row.releaseName}. Open details.`}
        onClick={() => onOpen(row)}
        onKeyDown={handleKeyDown}
      >
        <span className={styles.sheen} aria-hidden="true" />

        {/* The Name set on this deployment in the portal, joined on releaseId+env. Sits above the
            pipeline name because that is the fastest way to recognise "this is the batch X ran" --
            the pipeline name alone is the same on every run of it. */}
        {/* Banner strip above the title. Automated first: "who asked for this" is the first
            question about any deployment, and "nobody, it was a merge" is a different answer from
            a person's name. */}
        {(row.automated || row.portalName) && (
          <div className={styles.banners}>
            {row.automated && (
              <span
                className={styles.automated}
                title={
                  row.ciDeploy
                    ? 'Triggered by a merge -- this pipeline deploys inside its build, so it has no release'
                    : 'Triggered automatically, not started by a person'
                }
              >
                Automated deploy
              </span>
            )}
            {row.portalName && (
              <span className={styles.portalName} title={`Named in the portal by ${row.portalName}`}>
                {row.portalName}
              </span>
            )}
          </div>
        )}

        <header className={styles.head}>
          <div className={styles.headMain}>
            <h3 className={styles.pipeline} title={row.pipeline}>
              {row.pipeline || row.definitionName}
            </h3>
            <p className={styles.application} title={row.definitionName}>
              {row.application || row.definitionName}
            </p>
          </div>
          <div className={styles.headSide}>
            <span className={`${styles.envChip} ${envClass}`} title={`Azure DevOps environment: ${row.rawEnv}`}>
              {row.env}
            </span>
            {row.attempt > 1 && (
              <span className={styles.attempt} title="This deployment has been retried">
                Attempt {row.attempt}
              </span>
            )}
            <DeploymentStatusPill status={row.status} />
          </div>
        </header>

        {row.isStuck && (
          <p className={styles.stuckBanner}>
            <svg
              className={styles.stuckIcon}
              viewBox="0 0 14 14"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M7 1.7 L13 12.3 H1 Z" />
              <path d="M7 5.4 V8.6" />
              <path d="M7 10.4 h0.01" />
            </svg>
            <span>
              <strong>Stuck</strong>
              {row.stuckReason ? ` — ${row.stuckReason}` : ''}
            </span>
          </p>
        )}

        <div className={styles.grid}>
          <Field label="Release" value={row.releaseName} />
          <Field label="Branch" value={row.branch} />
          <Field label="Build" value={row.buildNumber} mono />
          <Field label="Commit" value={row.commitId} mono />
          {row.rawEnv && row.rawEnv !== row.env && <Field label="ADO environment" value={row.rawEnv} />}
          <Field label="Triggered by" value={row.triggeredBy} />
          <Field label="Started" value={formatTimestamp(row.startedOn)} />
          <Field label="Completed" value={formatTimestamp(row.completedOn)} />
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Duration</span>
            <LiveDuration
              className={`${styles.fieldValue} ${styles.mono}`}
              startedOn={row.startedOn}
              completedOn={row.completedOn}
              durationSeconds={row.durationSeconds}
              live={isRunning}
            />
          </div>
        </div>

        <footer className={styles.foot}>
          <div className={styles.links}>
            <ExternalLink href={row.adoReleaseUrl}>Release</ExternalLink>
            <ExternalLink href={row.adoLogsUrl}>Logs</ExternalLink>
            <ExternalLink href={row.adoBuildUrl}>Build</ExternalLink>
            {/* Downloads only for a deployment that actually failed -- that is the case where
                someone needs the log in hand to diagnose, and it mirrors the pair of options the
                My Deployments page already offers. rawEnv, not the bucket: the backend resolves the
                real ADO environment (PROD_TAG and friends) from it. */}
            {canDownloadLogs && (
              <>
                <DownloadLink href={failedSectionLogsUrl(row.releaseId, row.rawEnv, row.pipeline)}>
                  Failed step log
                </DownloadLink>
                <DownloadLink href={allLogsUrl(row.releaseId, row.pipeline)}>All logs</DownloadLink>
              </>
            )}
            <CopyTileLink row={row} />
            {canHide && <HideTileButton row={row} />}
          </div>
          <span className={styles.project} title={`Azure DevOps project: ${row.project}`}>
            {row.project}
          </span>
        </footer>
      </article>
    </div>
  )
}
