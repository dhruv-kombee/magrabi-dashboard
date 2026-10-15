import { useEffect, useMemo, useState } from 'react'
import { useDismissDeploymentsMutation, useMyDeploymentsQuery } from '../api/hooks'
import type { MyDeploymentRow } from '../api/types'
import { NewDeploymentForm } from '../components/NewDeploymentForm'
import { MyDeploymentsTable } from '../components/MyDeploymentsTable'
import { DeployedTable } from '../components/DeployedTable'
import { useApprovalAlerts } from '../hooks/useApprovalAlerts'
import pageStyles from './Page.module.css'
import styles from './AdminPage.module.css'
import { AdoUnreachableBanner } from '../components/AdoUnreachableBanner'

type Tab = 'ongoing' | 'deployed' | 'backup'

/** How long a dead row stays in Ongoing before it is filed away.
 *
 * Not immediate, on purpose: a deployment that just failed is the one you are most likely to rerun
 * or investigate, and moving it out from under you at that moment is exactly wrong. After three
 * hours it has stopped being today's problem and is just noise on the working list. */
const BACKUP_AFTER_MS = 3 * 60 * 60 * 1000

/** Terminal states that eventually get filed. Mirrors DISMISSABLE_STATUSES in the backend. */
const DEAD_STATUSES = new Set(['failed', 'canceled'])

/** Persisted so the badge survives a page load.
 *
 * Without this the "seen" set was component state, so every reload started empty and EVERY deployed
 * row counted as new -- which is why the tab permanently read "47 new" no matter how many times it
 * had been opened. */
const SEEN_KEY = 'deploy-portal-seen-deployed'
/** Cap so a long-lived browser does not grow this without bound. Comfortably more than the feed. */
const SEEN_MAX = 500

function rowKey(r: MyDeploymentRow): string {
  return `${r.pipeline}-${r.env}-${r.startedAt}`
}

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function ageMs(r: MyDeploymentRow): number {
  const t = r.startedAt ? Date.parse(r.startedAt) : NaN
  // Unparseable timestamp: treat as NEW so a row can never be filed away on a bad date.
  return Number.isNaN(t) ? 0 : Date.now() - t
}

export function AdminPage() {
  const { data, isLoading, isError, error } = useMyDeploymentsQuery(true)
  const rows = data?.rows ?? []
  const [tab, setTab] = useState<Tab>('ongoing')
  const [seenDeployedKeys, setSeenDeployedKeys] = useState<Set<string>>(readSeen)
  const [confirmFlush, setConfirmFlush] = useState(false)
  const [flushResult, setFlushResult] = useState<string | null>(null)
  const flush = useDismissDeploymentsMutation()
  // Watches ALL rows, not just the visible tab: a gate that opens while another tab is in front
  // still has the same ~60 seconds before ADO rejects it.
  const alerts = useApprovalAlerts(rows)

  // Re-evaluated on every 2s poll, so a row crosses the three-hour line on its own without needing
  // a timer of its own.
  const { ongoing, deployed, backup } = useMemo(() => {
    const deployed = rows.filter((r) => r.status === 'succeeded')
    const rest = rows.filter((r) => r.status !== 'succeeded')
    const backup = rest.filter((r) => DEAD_STATUSES.has(r.status) && ageMs(r) >= BACKUP_AFTER_MS)
    const ongoing = rest.filter((r) => !backup.includes(r))
    return { ongoing, deployed, backup }
  }, [rows])

  const newDeployedCount = useMemo(
    () => deployed.filter((r) => !seenDeployedKeys.has(rowKey(r))).length,
    [deployed, seenDeployedKeys],
  )

  // Marks everything currently in "deployed" as seen -- runs while the Deployed tab is the active
  // one (so a row that completes WHILE you are looking at it never shows a stale badge), and once
  // immediately when you switch to it.
  //
  // Only REPLACES the set when its contents actually differ, because a new Set is never
  // Object.is-equal to the old one: `rows` is a fresh [] on every render while `data` is undefined
  // (reachable -- logging out clears the query cache while this page is still mounted), so a fresh
  // `deployed` re-fires this effect and an unconditional setState would loop forever.
  useEffect(() => {
    if (tab !== 'deployed') return
    setSeenDeployedKeys((prev) => {
      const next = new Set(deployed.map(rowKey))
      if (next.size === prev.size && [...next].every((k) => prev.has(k))) return prev
      // Keep previously-seen keys too, so rows that have aged out of the feed do not come back as
      // "new" if they ever reappear. Newest last, trimmed from the front.
      const merged = [...prev, ...next]
      const trimmed = merged.slice(Math.max(0, merged.length - SEEN_MAX))
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set(trimmed)]))
      } catch {
        /* private mode or a full quota -- the badge is not worth failing the page over */
      }
      return new Set(trimmed)
    })
  }, [tab, deployed])

  function onFlush() {
    setFlushResult(null)
    flush.mutate(
      { runIds: backup.map((r) => r.runId) },
      {
        onSuccess: (r) => {
          setConfirmFlush(false)
          setFlushResult(r.message)
        },
        onError: (e) => {
          setConfirmFlush(false)
          setFlushResult((e as Error).message)
        },
      },
    )
  }

  return (
    <main className={pageStyles.main}>
      <AdoUnreachableBanner
        reachable={data?.adoReachable}
        error={data?.adoError}
        failedSince={data?.adoFailedSince}
      />
      <NewDeploymentForm />
      <div className={styles.alertBar}>
        <label className={styles.alertToggle}>
          <input
            type="checkbox"
            checked={alerts.enabled}
            onChange={(e) => alerts.setEnabled(e.target.checked)}
          />
          Alert me when an approval is needed
        </label>
        {/* Browsers only grant notification permission from a user gesture, so this has to be a
            button rather than something the page asks for on load. */}
        {alerts.enabled && alerts.permission === 'default' && (
          <button className={styles.alertEnable} onClick={() => void alerts.requestPermission()}>
            Enable browser notifications
          </button>
        )}
        {alerts.enabled && alerts.permission === 'denied' && (
          <span className={styles.alertHint}>
            Notifications blocked in this browser — the sound will still play while this tab is open.
          </span>
        )}
      </div>
      <p className={pageStyles.updated}>Last updated: {data?.updated ? `${data.updated} IST` : '…'}</p>
      {isLoading && <p className={pageStyles.loading}>Loading…</p>}
      {isError && <p className={pageStyles.error}>{(error as Error).message}</p>}
      {data && (
        <>
          <div className={styles.tabs}>
            <button
              className={`${styles.tabButton} ${tab === 'ongoing' ? styles.tabButtonActive : ''}`}
              onClick={() => setTab('ongoing')}
            >
              Ongoing <span className={styles.count}>({ongoing.length})</span>
            </button>
            <button
              className={`${styles.tabButton} ${styles.tabButtonWithBadge} ${tab === 'deployed' ? styles.tabButtonActiveDeployed : ''}`}
              onClick={() => setTab('deployed')}
            >
              Deployed <span className={styles.count}>({deployed.length})</span>
              {newDeployedCount > 0 && <span className={styles.badge}>{newDeployedCount} new</span>}
            </button>
            {/* Right of Deployed, and only once something has actually been filed -- an empty tab
                is just another thing to read past. */}
            {backup.length > 0 && (
              <button
                className={`${styles.tabButton} ${tab === 'backup' ? styles.tabButtonActive : ''}`}
                onClick={() => setTab('backup')}
                title="Failed and canceled runs older than 3 hours"
              >
                Backup failed <span className={styles.count}>({backup.length})</span>
              </button>
            )}
          </div>

          {tab === 'backup' && (
            <div className={styles.backupBar}>
              <span className={styles.backupNote}>
                Failed and canceled runs older than 3 hours. They stay on Ongoing until then so a
                fresh failure is still in front of you to rerun. Removing them is portal bookkeeping
                only — Azure DevOps is untouched.
              </span>
              {confirmFlush ? (
                <span className={styles.backupActions}>
                  <button
                    className={styles.flushConfirm}
                    onClick={onFlush}
                    disabled={flush.isPending}
                  >
                    {flush.isPending ? 'Removing…' : `Remove all ${backup.length}?`}
                  </button>
                  <button className={styles.flushCancel} onClick={() => setConfirmFlush(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className={styles.flushButton} onClick={() => setConfirmFlush(true)}>
                  Flush all ({backup.length})
                </button>
              )}
            </div>
          )}
          {flushResult && tab === 'backup' && (
            <p className={styles.flushResult}>{flushResult}</p>
          )}

          {tab === 'ongoing' && (
            <MyDeploymentsTable rows={ongoing} emptyMessage="Nothing in progress right now." />
          )}
          {tab === 'deployed' && <DeployedTable rows={deployed} />}
          {tab === 'backup' && (
            <MyDeploymentsTable rows={backup} emptyMessage="Nothing filed away." />
          )}
        </>
      )}
    </main>
  )
}
