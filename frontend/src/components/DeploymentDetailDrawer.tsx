import { useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { DeploymentRow } from '../api/types'
import { useBuildTimelineQuery, useDeploymentTimelineQuery } from '../api/hooks'
import { allLogsUrl, failedSectionLogsUrl } from '../api/client'
import { formatTimestamp } from '../utils/format'
import { PipelineStageFlow, formatDuration } from './PipelineStageFlow'
import { LogViewerModal } from './LogViewerModal'
import { StatusBadge } from './StatusBadge'
import styles from './DeploymentDetailDrawer.module.css'

/** Only a deployment that can still change is worth re-fetching. Everything else is frozen
 * history, and polling it would multiply Azure DevOps calls for a payload that never differs. */
const LIVE_STATUSES = new Set(['inProgress', 'queued', 'waiting'])
const LIVE_REFRESH_MS = 5000

interface LogTarget {
  phaseId: number
  taskId: number
  taskName: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong talking to Azure DevOps.'
}

function orDash(value: string | null | undefined): string {
  return value ? value : '--'
}

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.metaItem}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={`${styles.metaValue} ${mono ? styles.metaMono : ''}`}>{value}</dd>
    </div>
  )
}

interface DeploymentDetailDrawerProps {
  row: DeploymentRow
  onClose: () => void
}

export function DeploymentDetailDrawer({ row, onClose }: DeploymentDetailDrawerProps) {
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null)

  const isLive = LIVE_STATUSES.has(row.status)
  // A run whose CI build is still going has no release yet, and a pipeline that deploys inside its
  // own build never gets one at all. Asking for a step breakdown by releaseId 0 returned
  // "release 0 not found" and rendered a red failure box over a perfectly healthy deployment.
  // Skip the call entirely and say what is actually happening instead.
  const hasRelease = row.releaseId > 0
  const { data: timeline, isLoading, error } = useDeploymentTimelineQuery(
    row.releaseId,
    row.rawEnv,
    row.pipeline,
    hasRelease,
    isLive ? LIVE_REFRESH_MS : 0,
  )

  // No release yet? Then the interesting thing IS the build, and ADO knows exactly which of its
  // steps is executing. Fetched in the same shape as the deployment timeline so the identical live
  // step view renders it -- a placeholder telling someone to wait is strictly less useful than
  // showing them what is happening.
  const buildIsRunning = row.status === 'building' || row.status === 'queued'
  const {
    data: buildTimeline,
    isLoading: buildLoading,
    error: buildError,
  } = useBuildTimelineQuery(
    row.buildId,
    row.pipeline,
    row.project,
    !hasRelease,
    buildIsRunning ? LIVE_REFRESH_MS : 0,
  )

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // The log viewer stacks on top of this drawer and runs its own Escape handler. Both listen
      // on window, so without this guard one keypress would close the log AND rip the drawer away
      // underneath it.
      if (logTarget) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [logTarget, onClose])

  useEffect(() => {
    // The drawer scrolls its own body; leaving the page behind scrollable means a trackpad
    // flick past the drawer's end silently scrolls the table underneath instead.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  function handleBackdropClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  const envKey = ['DEV', 'SIT', 'UAT', 'PROD'].includes(row.env) ? row.env.toLowerCase() : 'other'
  const approvals = timeline?.approvals ?? []
  const showFailedSection = row.status === 'failed'

  return (
    <>
      <div className={styles.backdrop} onClick={handleBackdropClick} />

      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="deployment-detail-title"
      >
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <div className={styles.titleBlock}>
              <span className={styles.eyebrow}>Deployment detail</span>
              <h2 className={styles.title} id="deployment-detail-title">
                {row.pipeline}
              </h2>
              <span className={styles.subtitle}>{row.definitionName}</span>
            </div>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close deployment detail">
              <svg viewBox="0 0 24 24" className={styles.closeIcon} aria-hidden="true">
                <path d="M6 6 18 18" />
                <path d="M18 6 6 18" />
              </svg>
            </button>
          </div>

          <div className={styles.chips}>
            <span className={`${styles.envChip} ${styles[`env_${envKey}`]}`}>{row.rawEnv}</span>
            <StatusBadge status={row.status} />
            <span className={styles.plainChip}>Attempt {row.attempt}</span>
            <span className={styles.plainChip}>{row.project}</span>
          </div>

          {row.isStuck && row.stuckReason && (
            <p className={styles.stuck}>
              <strong>Looks stuck:</strong> {row.stuckReason}
            </p>
          )}

          <dl className={styles.meta}>
            <MetaItem label="Application" value={orDash(row.application)} />
            <MetaItem label="Release" value={orDash(row.releaseName)} />
            <MetaItem label="Build" value={orDash(row.buildNumber)} mono />
            <MetaItem label="Commit" value={orDash(row.commitId)} mono />
            <MetaItem label="Branch" value={orDash(row.branch)} mono />
            <MetaItem label="Triggered by" value={orDash(row.triggeredBy)} />
            <MetaItem label="Started" value={orDash(formatTimestamp(row.startedOn))} />
            <MetaItem label="Completed" value={orDash(formatTimestamp(row.completedOn))} />
            <MetaItem
              label="Duration"
              value={orDash(formatDuration(row.durationSeconds) + (isLive && row.durationSeconds ? ' so far' : ''))}
            />
            <MetaItem label="Reason" value={orDash(row.reason)} />
          </dl>
        </header>

        <div className={styles.body}>
          {!hasRelease ? (
            <>
              <div className={styles.waitingBox}>
                <strong className={styles.waitingTitle}>
                  {row.ciDeploy
                    ? 'Deploying inside the build'
                    : buildIsRunning
                      ? 'Building right now'
                      : 'Build finished -- preparing the release'}
                </strong>
                <span className={styles.waitingMessage}>
                  {row.ciDeploy
                    ? 'This pipeline deploys within its own build, so its Deploy stage is one of the steps below.'
                    : 'Live build steps below. The deployment steps replace them once the release is created.'}
                </span>
              </div>
              {buildError ? (
                <div className={styles.errorBox}>
                  <strong className={styles.errorTitle}>Could not load the build steps</strong>
                  <span className={styles.errorMessage}>{messageOf(buildError)}</span>
                </div>
              ) : (
                <PipelineStageFlow
                  timeline={buildTimeline}
                  isLoading={buildLoading}
                  row={row}
                  // Build task logs are not served through this portal, so no step offers one.
                  onViewLog={() => undefined}
                />
              )}
            </>
          ) : error ? (
            <div className={styles.errorBox}>
              <strong className={styles.errorTitle}>Could not load the step breakdown</strong>
              <span className={styles.errorMessage}>{messageOf(error)}</span>
              <span className={styles.errorHint}>
                The deployment itself is unaffected. You can still download the logs below, or open the
                release in Azure DevOps.
              </span>
            </div>
          ) : (
            <PipelineStageFlow
              timeline={timeline}
              isLoading={isLoading}
              row={row}
              onViewLog={(phaseId, taskId, taskName) => setLogTarget({ phaseId, taskId, taskName })}
            />
          )}

          {approvals.length > 0 && (
            <section className={styles.approvals}>
              <h3 className={styles.approvalsTitle}>Approvals</h3>
              <ul className={styles.approvalList}>
                {approvals.map((approval) => (
                  <li key={approval.id} className={styles.approval}>
                    <div className={styles.approvalTop}>
                      <span className={styles.approvalType}>{approval.type}</span>
                      <StatusBadge status={approval.status} />
                    </div>
                    <span className={styles.approvalWho}>{orDash(approval.approver)}</span>
                    {approval.comments && <p className={styles.approvalComment}>{approval.comments}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* download + target on both log links, and neither is optional: these hit an endpoint that
            answers a JSON error body on failure, and a same-tab navigation would render that body
            in place of the whole running SPA -- taking the drawer, the poll and the reader's place
            in the list with it. With these, a failed download can only ever open a throwaway tab. */}
        <footer className={styles.footer}>
          {/* Both log downloads are addressed by releaseId, so they can only 404 before a release
              exists. Hidden rather than offered and failing. */}
          {hasRelease && (
            <a
              className={styles.footerAction}
              href={allLogsUrl(row.releaseId, row.pipeline)}
              download
              target="_blank"
              rel="noreferrer"
            >
              Download all logs
            </a>
          )}
          {hasRelease && showFailedSection && (
            <a
              className={`${styles.footerAction} ${styles.footerDanger}`}
              href={failedSectionLogsUrl(row.releaseId, row.rawEnv, row.pipeline)}
              download
              target="_blank"
              rel="noreferrer"
            >
              Download failed-section logs
            </a>
          )}
          <a
            className={styles.footerLink}
            href={hasRelease ? row.adoLogsUrl : row.adoBuildUrl || row.adoLogsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {hasRelease ? 'Open in Azure DevOps' : 'Open build in Azure DevOps'}
          </a>
        </footer>
      </aside>

      {logTarget && (
        <LogViewerModal
          releaseId={row.releaseId}
          rawEnv={row.rawEnv}
          pipeline={row.pipeline}
          phaseId={logTarget.phaseId}
          taskId={logTarget.taskId}
          taskName={logTarget.taskName}
          onClose={() => setLogTarget(null)}
        />
      )}
    </>
  )
}
