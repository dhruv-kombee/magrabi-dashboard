import { useMemo } from 'react'
import type { DeploymentRow, DeploymentTimeline, TimelinePhase, TimelineTask } from '../api/types'
import { formatTimestamp } from '../utils/format'
import styles from './PipelineStageFlow.module.css'

/** Visual buckets for a single step. Deliberately NOT the same vocabulary as the normalized
 * deployment status the backend hands us on DeploymentRow -- that one describes the whole
 * deployment and the frontend must never re-derive it. These are per-task Azure DevOps values
 * (raw, by contract) and something has to turn ~10 of them into the handful of shapes the rail
 * can actually draw, so that mapping lives here. */
type StepKind = 'done' | 'running' | 'failed' | 'warned' | 'skipped' | 'pending'

const STEP_KIND_BY_STATUS: Record<string, StepKind> = {
  succeeded: 'done',
  succeededwithissues: 'warned',
  partiallysucceeded: 'warned',
  failed: 'failed',
  abandoned: 'failed',
  inprogress: 'running',
  cancelling: 'running',
  canceled: 'skipped',
  cancelled: 'skipped',
  skipped: 'skipped',
  pending: 'pending',
  notstarted: 'pending',
  queued: 'pending',
}

function stepKind(status: string): StepKind {
  const key = (status || '').toLowerCase().replace(/[^a-z]/g, '')
  return STEP_KIND_BY_STATUS[key] ?? 'pending'
}

/** A step counts as "settled" once it will never move again -- including skipped/canceled ones.
 * Excluding those would leave the progress bar permanently short of 100% on any deployment that
 * short-circuited, which reads as "still running" long after it finished. */
function isSettled(kind: StepKind): boolean {
  return kind !== 'pending' && kind !== 'running'
}

/** Shared by the drawer header too, hence the export -- the drawer imports from this module
 * rather than the reverse, so there is no import cycle. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return ''
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins ? `${hours}h ${remMins}m` : `${hours}h`
}

function StepIcon({ kind }: { kind: StepKind }) {
  if (kind === 'running') {
    // Not an SVG: the pulsing rings are pseudo-elements on this span, which keeps the animation
    // in CSS where prefers-reduced-motion can switch it off wholesale.
    return <span className={styles.runningDot} aria-hidden="true" />
  }
  if (kind === 'done') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <path d="M5 12.5 10 17.5 19 7" className={styles.checkPath} />
      </svg>
    )
  }
  if (kind === 'failed') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <path d="M7.5 7.5 16.5 16.5" className={styles.crossPath} />
        <path d="M16.5 7.5 7.5 16.5" className={styles.crossPathLate} />
      </svg>
    )
  }
  if (kind === 'warned') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <path d="M12 6.5 12 13.5" />
        <circle cx="12" cy="17.2" r="1.35" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (kind === 'skipped') {
    return (
      <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
        <path d="M7 12 17 12" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
      <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

interface StepNodeProps {
  task: TimelineTask
  kind: StepKind
  isLast: boolean
  /** True once flow has passed this node, so the rail below it draws as travelled. */
  railFilled: boolean
  railFailed: boolean
  /** True when the NEXT step is the one running -- this is the rail the shimmer travels down. */
  railActive: boolean
  onViewLog: (phaseId: number, taskId: number, taskName: string) => void
}

function StepNode({ task, kind, isLast, railFilled, railFailed, railActive, onViewLog }: StepNodeProps) {
  const started = formatTimestamp(task.startTime)
  const duration = formatDuration(task.durationSeconds)
  const issues = task.issues ?? []

  return (
    <li className={`${styles.step} ${styles[`step_${kind}`]}`}>
      <div className={styles.gutter}>
        {!isLast && (
          <span
            className={[
              styles.rail,
              railFilled ? styles.railFilled : '',
              railFailed ? styles.railFailedTone : '',
              railActive ? styles.railActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            <span className={styles.railFill} />
            {railActive && <span className={styles.railShimmer} />}
          </span>
        )}
        <span className={styles.marker}>
          <StepIcon kind={kind} />
        </span>
      </div>

      <div className={styles.stepBody}>
        <div className={styles.stepTop}>
          <span className={styles.stepName}>{task.name}</span>
          <span className={styles.stepState}>{task.status}</span>
        </div>

        <div className={styles.stepMeta}>
          {started && <span>Started {started}</span>}
          {duration && <span>Took {duration}</span>}
          {task.agentName && <span>Agent {task.agentName}</span>}
          {!started && !duration && !task.agentName && <span>Not started yet</span>}
        </div>

        {issues.length > 0 && (
          <ul className={styles.issueList}>
            {issues.map((issue, i) => (
              <li key={i} className={styles.issue}>
                <span className={styles.issueType}>{issue.type || 'error'}</span>
                <span className={styles.issueMessage}>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}

        {task.hasLog && (
          <button
            type="button"
            className={styles.logButton}
            onClick={() => onViewLog(task.phaseId, task.id, task.name)}
          >
            View log
          </button>
        )}
      </div>
    </li>
  )
}

function StageBlock({
  phase,
  onViewLog,
}: {
  phase: TimelinePhase
  onViewLog: (phaseId: number, taskId: number, taskName: string) => void
}) {
  const tasks = phase.tasks ?? []
  const kinds = tasks.map((t) => stepKind(t.status))
  const settled = kinds.filter(isSettled).length
  const phaseIsRunning = kinds.some((k) => k === 'running')
  const started = formatTimestamp(phase.startedOn)

  return (
    <section className={`${styles.stage} ${phaseIsRunning ? styles.stageRunning : ''}`}>
      <header className={styles.stageHeader}>
        <span className={styles.stageRank}>{phase.rank}</span>
        <div className={styles.stageTitleBlock}>
          <h4 className={styles.stageName}>{phase.name}</h4>
          <span className={styles.stageSub}>
            {tasks.length > 0 ? `${settled} of ${tasks.length} steps complete` : 'No steps reported'}
            {started ? ` · started ${started}` : ''}
          </span>
        </div>
        <span className={`${styles.stageStatus} ${styles[`tone_${stepKind(phase.status)}`]}`}>{phase.status}</span>
      </header>

      {tasks.length === 0 ? (
        <p className={styles.stageEmpty}>Azure DevOps has not reported any steps for this stage.</p>
      ) : (
        <ol className={styles.steps}>
          {tasks.map((task, i) => {
            const kind = kinds[i]
            const nextKind = kinds[i + 1]
            return (
              <StepNode
                key={task.id}
                task={task}
                kind={kind}
                isLast={i === tasks.length - 1}
                railFilled={isSettled(kind)}
                railFailed={kind === 'failed'}
                railActive={nextKind === 'running'}
                onViewLog={onViewLog}
              />
            )
          })}
        </ol>
      )}
    </section>
  )
}

interface PipelineStageFlowProps {
  timeline: DeploymentTimeline | undefined
  isLoading: boolean
  row: DeploymentRow
  onViewLog: (phaseId: number, taskId: number, taskName: string) => void
}

export function PipelineStageFlow({ timeline, isLoading, row, onViewLog }: PipelineStageFlowProps) {
  // Computed before any early return so the hook order stays stable across loading/loaded renders.
  const progress = useMemo(() => {
    const tasks = (timeline?.phases ?? []).flatMap((p) => p.tasks ?? [])
    const settled = tasks.filter((t) => isSettled(stepKind(t.status))).length
    const running = tasks.find((t) => stepKind(t.status) === 'running')
    return {
      total: tasks.length,
      settled,
      runningName: running ? running.name : null,
      percent: tasks.length ? Math.round((settled / tasks.length) * 100) : 0,
    }
  }, [timeline])

  if (isLoading && !timeline) {
    return (
      <div className={styles.placeholder}>
        <div className={styles.skeletonBar} />
        <div className={styles.skeletonBar} />
        <div className={styles.skeletonBar} />
        <p className={styles.placeholderText}>Loading step detail from Azure DevOps...</p>
      </div>
    )
  }

  if (!timeline) {
    return (
      <div className={styles.placeholder}>
        <p className={styles.placeholderText}>
          Step detail is not available for this deployment yet.
        </p>
        <p className={styles.placeholderHint}>
          {row.status === 'queued' || row.status === 'waiting'
            ? `This deployment to ${row.rawEnv} has not begun executing, so Azure DevOps has no steps to report. Detail appears as soon as the first stage starts.`
            : `Azure DevOps returned no stage breakdown for release ${row.releaseName} in ${row.rawEnv}.`}
        </p>
      </div>
    )
  }

  const phases = timeline.phases ?? []

  return (
    <div className={styles.flow}>
      <div className={styles.overall}>
        <div className={styles.overallTop}>
          <span className={styles.overallLabel}>
            {progress.total > 0
              ? `${progress.settled} of ${progress.total} steps complete`
              : 'No steps reported'}
          </span>
          <span className={styles.overallPercent}>{progress.percent}%</span>
        </div>
        <div
          className={styles.overallTrack}
          role="progressbar"
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Deployment step progress"
        >
          <span
            className={`${styles.overallFill} ${progress.runningName ? styles.overallFillLive : ''}`}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <p className={styles.overallNow}>
          {progress.runningName ? (
            <>
              <span className={styles.nowDot} aria-hidden="true" />
              Running now: <strong>{progress.runningName}</strong>
            </>
          ) : (
            `Steps for ${row.pipeline} in ${row.rawEnv}`
          )}
        </p>
      </div>

      {phases.length === 0 ? (
        <div className={styles.placeholder}>
          <p className={styles.placeholderText}>This deployment reported no stages.</p>
          <p className={styles.placeholderHint}>
            That usually means it was rejected or canceled before any agent picked it up.
          </p>
        </div>
      ) : (
        phases.map((phase) => <StageBlock key={phase.id} phase={phase} onViewLog={onViewLog} />)
      )}
    </div>
  )
}
