import { useMemo, useState } from 'react'
import {
  useCreateProdPlanMutation,
  useIdentityQuery,
  useProdAppsQuery,
  useProdNotRunQuery,
  useProdPlansQuery,
  useProdWatchlistQuery,
  useRejectProdApprovalMutation,
} from '../api/hooks'
import { ProductionPlan } from '../components/ProductionPlan'
import styles from './ProductionPage.module.css'

const TIERS = ['PROD', 'BETA'] as const

/** Beta and production deployments.
 *
 * Deliberately one column and one decision at a time. The first version of this screen showed the
 * whole recipe, every check, a watchlist, a problems panel and a card grid simultaneously -- it
 * explained the estate accurately and left you no idea what to press. This version asks only
 * "which application", then "what for", then walks one step at a time.
 */
export function ProductionPage() {
  const [tier, setTier] = useState<(typeof TIERS)[number]>('PROD')
  const [selected, setSelected] = useState<string | null>(null)
  const [planId, setPlanId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [showLimits, setShowLimits] = useState(false)

  const { data: identity } = useIdentityQuery()
  const isAdmin = identity?.role === 'admin'
  const { data: board, isLoading, isError, error } = useProdAppsQuery()
  const { data: plans } = useProdPlansQuery()
  const { data: watch } = useProdWatchlistQuery()
  const { data: notRun } = useProdNotRunQuery()
  const createPlan = useCreateProdPlanMutation()
  const rejectApproval = useRejectProdApprovalMutation()

  const apps = useMemo(
    () => (board?.apps ?? []).filter((a) => a.tier === tier),
    [board, tier],
  )
  const app = apps.find((a) => a.appKey === selected) ?? null

  // A run already open for this application, so closing the page does not lose your place.
  const existing = useMemo(
    () => (plans?.plans ?? []).find((p) => p.appKey === selected && p.tier === tier) ?? null,
    [plans, selected, tier],
  )

  const autoQueued = watch?.items?.filter((i) => i.autoQueued) ?? []

  if (isLoading) {
    return <main className={styles.page}><p className={styles.muted}>Loading...</p></main>
  }
  if (isError) {
    return (
      <main className={styles.page}>
        <p className={styles.error}>
          Could not read the pipelines. {error instanceof Error ? error.message : ''}
        </p>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.h1}>Beta &amp; Production</h1>
        <div className={styles.tierSwitch} role="tablist">
          {TIERS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tier === t}
              className={`${styles.tierTab} ${tier === t ? styles.tierTabOn : ''}`}
              onClick={() => { setTier(t); setSelected(null); setPlanId(null) }}
            >
              {t === 'PROD' ? 'Production' : 'Beta'}
            </button>
          ))}
        </div>
      </header>

      {/* Only ever shown when something is genuinely wrong: a production approval that queued
          itself off the back of a lower-environment deploy. Not a standing panel. */}
      {autoQueued.length > 0 && (
        <section className={styles.alert}>
          <strong className={styles.alertTitle}>
            {autoQueued.length === 1
              ? 'A production approval is waiting that nobody asked for'
              : `${autoQueued.length} production approvals are waiting that nobody asked for`}
          </strong>
          {autoQueued.map((i) => (
            <div key={`${i.project}-${i.approvalId}`} className={styles.alertRow}>
              <span>
                <strong>{i.definitionName}</strong> · {i.stage} · {i.releaseName}
              </span>
              {isAdmin && (
                <button
                  type="button"
                  className={styles.rejectBtn}
                  disabled={rejectApproval.isPending}
                  onClick={() => rejectApproval.mutate({
                    project: i.project, approvalId: i.approvalId,
                    reason: 'Not requested - queued automatically',
                  })}
                >
                  Reject
                </button>
              )}
              <a href={i.url} target="_blank" rel="noreferrer" className={styles.link}>Open</a>
            </div>
          ))}
        </section>
      )}

      {/* Step one: which application. A plain list -- the old card grid carried version, namespace,
          step count and defect counts on every tile, none of which help you choose. */}
      <section className={styles.picker}>
        {apps.length === 0 && (
          <p className={styles.muted}>Nothing set up for {tier === 'PROD' ? 'production' : 'beta'} yet.</p>
        )}
        {apps.map((a) => {
          const on = selected === a.appKey
          const blocked = a.problems.length > 0
          return (
            <button
              key={a.appKey}
              type="button"
              className={`${styles.appRow} ${on ? styles.appRowOn : ''}`}
              onClick={() => {
                const next = on ? null : a.appKey
                setSelected(next)
                setPlanId(null)
                setReason('')
              }}
            >
              <span className={styles.appName}>{a.displayName}</span>
              <span className={styles.appMeta}>{a.stepCount} steps</span>
              {blocked && <span className={styles.appFlag}>needs attention</span>}
            </button>
          )
        })}
      </section>

      {app && !planId && (
        <section className={styles.start}>
          {app.problems.map((p) => (
            <p key={p} className={styles.problem}>{p}</p>
          ))}

          {existing ? (
            <div className={styles.resume}>
              <span>There is a run already open for this: <strong>{existing.reason}</strong></span>
              <button type="button" className={styles.primary}
                      onClick={() => setPlanId(existing.planId)}>
                Carry on with it
              </button>
            </div>
          ) : (
            <div className={styles.startRow}>
              <input
                className={styles.reason}
                placeholder="What is this deployment for?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={!isAdmin}
              />
              <button
                type="button"
                className={styles.primary}
                disabled={!isAdmin || reason.trim().length < 8 || createPlan.isPending}
                onClick={() => createPlan.mutate(
                  { appKey: app.appKey, tier, reason: reason.trim() },
                  { onSuccess: (r) => { if (r.ok) { setPlanId(r.planId); setReason('') } } },
                )}
              >
                {createPlan.isPending ? 'Starting...' : 'Start'}
              </button>
            </div>
          )}
          {!isAdmin && <p className={styles.muted}>Viewers can read this page but not deploy.</p>}
          {createPlan.data && !createPlan.data.ok && (
            <p className={styles.error}>{createPlan.data.message}</p>
          )}
        </section>
      )}

      {planId && <ProductionPlan planId={planId} onClose={() => setPlanId(null)} />}

      {/* The portal's own limits, and the steps it will not run. Real information, but it belongs
          at the bottom behind a disclosure -- it was previously two panels above the fold. */}
      <footer className={styles.footer}>
        <button type="button" className={styles.disclose} onClick={() => setShowLimits((v) => !v)}>
          {showLimits ? 'Hide' : 'What this page will not do'}
        </button>
        {showLimits && (
          <div className={styles.limits}>
            {notRun?.never && (
              <p>The portal will never {notRun.never.join(', never ')}. Those stay in Azure DevOps.</p>
            )}
            {(notRun?.items ?? []).filter((i) => i.tier === tier).length > 0 && (
              <ul>
                {(notRun?.items ?? [])
                  .filter((i) => i.tier === tier)
                  .map((i) => (
                    <li key={`${i.appKey}-${i.stepId}`}>
                      <strong>{i.displayName}</strong> — {i.title}: {i.reason}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </footer>
    </main>
  )
}
