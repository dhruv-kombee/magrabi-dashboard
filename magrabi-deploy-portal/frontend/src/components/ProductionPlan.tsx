import { useState } from 'react'
import {
  useProdBuildsQuery,
  useProdPlanQuery,
  useProdStepActionMutation,
} from '../api/hooks'
import type { ProdPlanStep } from '../api/types'
import styles from './ProductionPlan.module.css'

const DONE = new Set(['verified', 'acknowledged'])

/** What a step is waiting for, in one short phrase. Shown on the collapsed rows so the whole
 * sequence reads top-to-bottom without opening anything. */
function stateWord(step: ProdPlanStep): string {
  switch (step.progress.state) {
    case 'verified':
      return 'Done'
    case 'acknowledged':
      return 'Done by hand'
    case 'prepared':
      return 'Ready to start'
    case 'started':
      return step.progress.stageStatus === 'inProgress' ? 'Waiting for approval' : 'Running'
    case 'failed':
      return 'Stopped'
    default:
      return step.portalMayStart ? 'Not started' : 'You do this one'
  }
}

/** The buttons for whichever step is current. Everything the old screen showed at once -- pins,
 * approval windows, every passing check -- is deliberately not here: it belongs on the step you
 * are about to run, not on all five simultaneously. */
function StepActions({
  step,
  tier,
  appKey,
  busy,
  act,
}: {
  step: ProdPlanStep
  tier: string
  appKey: string
  busy: boolean
  act: ReturnType<typeof useProdStepActionMutation>
}) {
  const [buildId, setBuildId] = useState('')
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState('')
  const needsBuild = (step.pins ?? []).some((p) => p.type === 'Build')
  const { data: builds } = useProdBuildsQuery(appKey, tier, needsBuild ? step.stepId : null)
  const st = step.progress.state
  const run = (action: 'prepare' | 'start' | 'discard' | 'reject' | 'verify' | 'confirm',
               body?: Record<string, unknown>) =>
    act.mutate({ stepId: step.stepId, action, body })

  // A step the portal does not run: a repository edit, a registry unlock, a CI build.
  if (!step.portalMayStart) {
    if (st === 'acknowledged') return null
    return (
      <div className={styles.row}>
        <input
          className={styles.note}
          placeholder="Anything worth recording? (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="button" className={styles.go} disabled={busy}
                onClick={() => run('confirm', { note })}>
          I have done this
        </button>
      </div>
    )
  }

  if (st === 'pending') {
    return (
      <div className={styles.row}>
        {needsBuild && (
          <select className={styles.select} value={buildId}
                  onChange={(e) => setBuildId(e.target.value)}>
            <option value="">Which build...</option>
            {(builds?.builds ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.buildNumber} — {b.branch}
              </option>
            ))}
          </select>
        )}
        <button type="button" className={styles.go}
                disabled={busy || !step.canPrepare || (needsBuild && !buildId)}
                onClick={() => run('prepare', needsBuild ? { buildId } : {})}>
          {busy ? 'Working...' : 'Get it ready'}
        </button>
        <span className={styles.hint}>Creates the release and pins it. Nothing starts yet.</span>
      </div>
    )
  }

  if (st === 'prepared') {
    return (
      <div className={styles.row}>
        <span className={styles.ready}>
          {step.progress.releaseName} is pinned and ready.
        </span>
        {step.startToken ? (
          <>
            <input
              className={styles.confirm}
              placeholder={`type ${tier}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" className={styles.danger}
                    disabled={busy || typed.trim().toUpperCase() !== tier}
                    onClick={() => run('start', { confirm: step.startToken })}>
              Start it
            </button>
          </>
        ) : (
          <span className={styles.hint}>Something changed — reload and check again.</span>
        )}
        <button type="button" className={styles.quiet} disabled={busy}
                onClick={() => run('discard')}>
          Discard
        </button>
      </div>
    )
  }

  if (st === 'started') {
    return (
      <div className={styles.row}>
        <span className={styles.ready}>
          {step.progress.releaseName} is running.
          {step.approval?.timeoutMinutes ? ` Approve within ${step.approval.timeoutMinutes} min.` : ''}
        </span>
        {step.progress.url && (
          <a className={styles.link} href={step.progress.url} target="_blank" rel="noreferrer">
            Open in Azure DevOps
          </a>
        )}
        <button type="button" className={styles.go} disabled={busy} onClick={() => run('verify')}>
          Did it finish?
        </button>
        <button type="button" className={styles.quiet} disabled={busy} onClick={() => run('reject')}>
          Reject
        </button>
      </div>
    )
  }

  // failed
  return (
    <div className={styles.row}>
      <span className={styles.failed}>
        Stopped{step.progress.stageStatus ? ` — ${step.progress.stageStatus}` : ''}.
      </span>
      {step.progress.url && (
        <a className={styles.link} href={step.progress.url} target="_blank" rel="noreferrer">
          See why
        </a>
      )}
      <button type="button" className={styles.quiet} disabled={busy} onClick={() => run('verify')}>
        Check again
      </button>
    </div>
  )
}

/** One run of one application's sequence, as a stepper.
 *
 * Only the step you are on is open. Finished steps collapse to a single line and future steps are
 * dimmed, so the page answers "what do I do now" in one glance instead of presenting five steps
 * and every check at once -- which is what made the first version of this screen unreadable.
 */
export function ProductionPlan({ planId, onClose }: { planId: string; onClose: () => void }) {
  const { data, isLoading } = useProdPlanQuery(planId)
  const act = useProdStepActionMutation(planId)
  const [openId, setOpenId] = useState<string | null>(null)

  if (isLoading || !data?.ok) return <p className={styles.muted}>Loading...</p>

  const { plan, steps } = data
  const done = steps.filter((s) => DONE.has(s.progress.state)).length
  // The first step that is not finished is the one you are on.
  const current = steps.find((s) => !DONE.has(s.progress.state)) ?? null

  return (
    <section className={styles.panel}>
      <header className={styles.head}>
        <div>
          <h3 className={styles.title}>{plan.displayName} · {plan.tier}</h3>
          <p className={styles.sub}>{plan.reason}</p>
        </div>
        <span className={styles.count}>{done} of {steps.length}</span>
        <button type="button" className={styles.close} onClick={onClose}>Close</button>
      </header>

      {act.data && !act.data.ok && <p className={styles.err}>{act.data.message}</p>}
      {act.isError && (
        <p className={styles.err}>
          {act.error instanceof Error ? act.error.message : 'That did not work.'}
        </p>
      )}
      {act.data?.ok && (act.data.note || act.data.message) && (
        <p className={styles.ok}>{act.data.note || act.data.message}</p>
      )}

      <ol className={styles.steps}>
        {steps.map((s) => {
          const isDone = DONE.has(s.progress.state)
          const isCurrent = current?.stepId === s.stepId
          const open = isCurrent || openId === s.stepId
          const blockers = s.checks.filter((c) => c.status === 'block')
          const warnings = s.checks.filter((c) => c.status === 'warn')
          return (
            <li
              key={s.stepId}
              className={[
                styles.step,
                isDone ? styles.isDone : '',
                isCurrent ? styles.isCurrent : '',
                !isDone && !isCurrent ? styles.isFuture : '',
              ].join(' ')}
            >
              <button
                type="button"
                className={styles.stepHead}
                onClick={() => setOpenId(openId === s.stepId ? null : s.stepId)}
              >
                <span className={styles.mark}>{isDone ? '' : s.order}</span>
                <span className={styles.stepName}>{s.title}</span>
                <span className={styles.stepState}>{stateWord(s)}</span>
              </button>

              {open && (
                <div className={styles.body}>
                  <p className={styles.plain}>{s.plain}</p>

                  {/* Only what stops or complicates THIS step. Passing checks are not shown --
                      a wall of green is noise, and it buried the two lines that mattered. */}
                  {blockers.map((c) => (
                    <p key={c.id} className={styles.block}>
                      <strong>{c.title}.</strong> {c.detail}
                      {c.action ? ` ${c.action}` : ''}
                    </p>
                  ))}
                  {blockers.length === 0 &&
                    warnings.map((c) => (
                      <p key={c.id} className={styles.warn}>
                        <strong>{c.title}.</strong> {c.detail}
                      </p>
                    ))}

                  {isCurrent && (
                    <StepActions
                      step={s}
                      tier={plan.tier}
                      appKey={plan.appKey}
                      busy={act.isPending}
                      act={act}
                    />
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {done === steps.length && (
        <p className={styles.allDone}>
          All {steps.length} steps finished. {plan.displayName} {plan.tier} is deployed.
        </p>
      )}
    </section>
  )
}
