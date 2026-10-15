import { useMemo } from 'react'
import type {
  Destination,
  DestinationKind,
  KeyVaultEnv,
  KeyVaultResultAction,
  KeyVaultRollbackResult,
  KeyVaultRolledBackSecret,
  KeyVaultSyncResult,
  KeyVaultWriteTotals,
} from '../api/types'
import { formatTimestamp } from '../utils/format'
import styles from './KeyRotationResult.module.css'

/** One run, as this view needs it.
 *
 * Deliberately NOT one of the API types. Three different payloads have to render here identically
 * -- a sync response, a rollback response, and a persisted run record read back out of history --
 * and only the record carries `by`, `at`, `env` and `action`. Narrowing on which of the three
 * arrived would mean three nearly identical tables; widening the fields the record adds to
 * optional gives one table, and the page fills `env`/`action` in from what it just asked for.
 *
 * `results` is typed as the rollback row because it is the superset: the three vault fields are
 * optional on it, so a sync's rows satisfy it unchanged.
 */
export type KeyRotationRunView = {
  ok?: boolean
  runId: string
  dryRun: boolean
  message?: string
  env?: KeyVaultEnv
  action?: 'sync' | 'rollback'
  by?: string
  at?: string
  totals?: KeyVaultWriteTotals
  refused?: Destination[]
  results?: KeyVaultRollbackResult[]
  rolledBack?: KeyVaultRolledBackSecret[]
}

/** Plain-language name for a destination kind, with the consequence attached where there is one.
 *
 * "Docker build argument" is not jargon worth hiding: it is the fact that decides whether a
 * redeploy is enough. A stage variable is picked up by the next release; a build argument is baked
 * into an image and needs a rebuild. Both labels match what the Variables page already says, so
 * someone cross-referencing the two screens reads the same words. */
function describeKind(kind: DestinationKind): string {
  return kind === 'build-argument' ? 'Built into image' : 'Release stage'
}

/** Azure DevOps' own term, kept underneath the plain one for the same reason the Variables page
 * keeps it: the person comparing this table against ADO has to find the same word in both. */
function kindTerm(kind: DestinationKind): string {
  return kind === 'build-argument' ? 'Docker build argument' : 'stage variable'
}

const ACTION_CLASS: Record<KeyVaultResultAction, string> = {
  written: styles.actionWritten,
  unchanged: styles.actionUnchanged,
  refused: styles.actionRefused,
  failed: styles.actionFailed,
  // Rollback only, and not an error: the secret had no earlier distinct version to go back to.
  skipped: styles.actionSkipped,
}

/** Revision before to after. A write bumps the definition revision, so this pair is the receipt:
 * it is the one number in the row that Azure DevOps also shows, which makes it the thing you can
 * check independently. Where nothing was written the arrow would be a lie, so it is not drawn. */
function revisionPair(row: KeyVaultSyncResult): string {
  const before = row.revisionBefore ?? null
  const after = row.revisionAfter ?? null
  if (before === null && after === null) return '—'
  if (after === null || after === before) return `${before ?? '—'}`
  return `${before ?? '—'} → ${after}`
}

/** Hash prefixes before and after, in the same shape as the revision pair.
 *
 * These are 10-character SHA-256 prefixes, never a value or any part of one. Showing them is how
 * the table proves two places agree without ever carrying the credential: identical prefixes mean
 * identical values, and a changed prefix is what "this rotated" looks like. */
function hashPair(row: KeyVaultSyncResult): string {
  const before = row.hashBefore ?? '—'
  const after = row.hashAfter ?? '—'
  return before === after ? before : `${before} → ${after}`
}

type Group = {
  key: string
  project: string
  defId: number
  defName: string
  rows: KeyVaultSyncResult[]
  written: number
  bad: number
}

/** What a sync or rollback actually did, grouped by release definition.
 *
 * This is the part of the section people came for: not "it worked", but WHICH variable in WHICH
 * definition changed, and from which revision to which. It is rendered identically for a live run
 * and for a run pulled back out of history, which is why it takes a whole run record rather than
 * props assembled by the caller -- a history entry and a fresh response are the same shape.
 *
 * It never shows a credential. The only value-ish thing on screen is a 10-character SHA-256
 * prefix; there is deliberately no code path here that could render a secret, masked or otherwise.
 */
export function KeyRotationResult({
  run,
  onDismiss,
  heading,
}: {
  run: KeyRotationRunView
  onDismiss?: () => void
  heading?: string
}) {
  // Grouped in first-seen order rather than sorted: the backend emits results in plan order, which
  // already walks definition by definition, and re-sorting would scramble the sequence someone
  // watching the run just saw.
  const groups = useMemo<Group[]>(() => {
    const byDef = new Map<string, Group>()
    for (const row of run.results ?? []) {
      const key = `${row.project}|${row.defId}`
      let g = byDef.get(key)
      if (!g) {
        g = {
          key,
          project: row.project,
          defId: row.defId,
          defName: row.defName,
          rows: [],
          written: 0,
          bad: 0,
        }
        byDef.set(key, g)
      }
      g.rows.push(row)
      if (row.action === 'written') g.written += 1
      if (row.action === 'refused' || row.action === 'failed') g.bad += 1
    }
    return [...byDef.values()]
  }, [run.results])

  const totals = run.totals ?? { written: 0, unchanged: 0, refused: 0, failed: 0 }
  const bad = totals.refused + totals.failed
  // Three tones, not two. A dry run is not a success and not a failure -- it is a rehearsal, and
  // it gets its own colour so a preview on screen is never read as a completed rotation.
  const tone = run.dryRun
    ? styles.wrapDry
    : bad > 0 || run.ok === false
      ? styles.wrapBad
      : styles.wrapWrote

  const rolledBack = run.rolledBack ?? []
  const refused = run.refused ?? []

  return (
    <section className={`${styles.wrap} ${tone}`} aria-label={heading ?? 'Run result'}>
      <div className={styles.head}>
        <div>
          <h3 className={styles.title}>
            {heading ?? (run.action === 'rollback' ? 'Rollback result' : 'Sync result')}
            {run.dryRun && <span className={styles.dryPill}>Preview — nothing written</span>}
          </h3>
          <p className={styles.message}>{run.message}</p>
          <span className={styles.runId}>
            Run {run.runId}
            {run.by ? ` · by ${run.by}` : ''}
            {run.at ? ` · ${formatTimestamp(run.at)}` : ''}
            {run.env ? ` · ${run.env.toUpperCase()}` : ''}
          </span>
        </div>
        {/* Stays on screen until dismissed on purpose: this is the record of what just changed in
            a production definition, and losing it to the next poll or a stray click is not
            acceptable. */}
        {onDismiss && (
          <button type="button" className={styles.dismiss} onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>

      <ul className={styles.totals}>
        <li className={styles.total}>
          <strong>{totals.written}</strong> {run.dryRun ? 'would change' : 'written'}
        </li>
        <li className={styles.total}>
          <strong>{totals.unchanged}</strong> already matched
        </li>
        <li className={`${styles.total} ${totals.refused > 0 ? styles.totalBad : ''}`}>
          <strong>{totals.refused}</strong> refused
        </li>
        <li className={`${styles.total} ${totals.failed > 0 ? styles.totalBad : ''}`}>
          <strong>{totals.failed}</strong> failed
        </li>
        {/* Rollback only. A skipped secret simply had no earlier distinct version -- it is not a
            failure, and counting it as one would make a clean rollback look broken. */}
        {totals.skipped !== undefined && (
          <li className={styles.total}>
            <strong>{totals.skipped}</strong> skipped
          </li>
        )}
      </ul>

      {/* The vault half of a rollback. Without it the table below reads as "these pipelines
          changed" with no statement of what they changed TO -- and on a rollback, the vault version
          that was restored is exactly the thing someone will be asked for afterwards. */}
      {rolledBack.length > 0 && (
        <div className={styles.vaultBlock}>
          <h4 className={styles.blockTitle}>Key Vault versions restored</h4>
          <ul className={styles.vaultList}>
            {rolledBack.map((r) => (
              <li key={r.secret}>
                <span className={styles.mono}>{r.secret}</span>
                <span className={styles.muted}> ({r.service})</span> —{' '}
                <span className={styles.mono}>{r.vaultHashFrom ?? '—'}</span> →{' '}
                <span className={styles.mono}>{r.vaultHashTo ?? '—'}</span>
                {r.vaultVersionRestored && (
                  <span className={styles.muted}>
                    {' '}
                    · version <span className={styles.mono}>{r.vaultVersionRestored}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Refused destinations come back as their own array as well as rows in the table. Listed
          separately because a refusal is not a failed write -- it is the check working: a pipeline
          holding a value the vault has never held is a mapping error, and overwriting it would hand
          a service somebody else's credential. */}
      {refused.length > 0 && (
        <div className={styles.vaultBlock}>
          <h4 className={styles.blockTitle}>Refused — mapping not confirmed</h4>
          <ul className={styles.vaultList}>
            {refused.map((d) => (
              <li key={`${d.project}-${d.defId}-${d.stage}-${d.variable}`}>
                <span className={styles.mono}>{d.variable}</span> in {d.defName} ({d.project} def{' '}
                {d.defId}), stage {d.stage} — holds a value this vault has never held
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length === 0 ? (
        <p className={styles.empty}>
          Nothing was in scope for this run — no destination needed changing.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className={styles.group}>
            <div className={styles.groupHead}>
              <span className={styles.groupName}>{g.defName}</span>
              <span className={styles.groupMeta}>
                {g.project} · def {g.defId} · {g.rows.length} destination
                {g.rows.length === 1 ? '' : 's'}
                {g.written > 0 ? ` · ${g.written} ${run.dryRun ? 'would change' : 'changed'}` : ''}
                {g.bad > 0 ? ` · ${g.bad} not applied` : ''}
              </span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Secret</th>
                    <th scope="col">Service</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Variable</th>
                    <th scope="col">Where it lives</th>
                    <th scope="col" className={styles.hideNarrow}>
                      Hash
                    </th>
                    <th scope="col">Revision</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((row) => {
                    const isBad = row.action === 'refused' || row.action === 'failed'
                    return (
                      <tr
                        key={`${row.secret}-${row.stage}-${row.variable}-${row.kind}`}
                        className={
                          isBad ? styles.rowBad : row.action === 'written' ? styles.rowWritten : ''
                        }
                      >
                        <td className={styles.mono}>{row.secret}</td>
                        <td className={styles.nowrap}>{row.service}</td>
                        <td className={styles.nowrap}>{row.stage}</td>
                        <td className={styles.mono}>{row.variable}</td>
                        <td className={styles.nowrap}>
                          {describeKind(row.kind)}
                          <span className={styles.kindTerm}>{kindTerm(row.kind)}</span>
                        </td>
                        <td className={`${styles.mono} ${styles.hideNarrow}`}>{hashPair(row)}</td>
                        <td className={styles.rev}>{revisionPair(row)}</td>
                        <td>
                          <span className={`${styles.action} ${ACTION_CLASS[row.action]}`}>
                            {row.action}
                          </span>
                          {row.message && <span className={styles.rowMessage}>{row.message}</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </section>
  )
}
