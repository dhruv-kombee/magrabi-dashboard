import { useMemo, useState } from 'react'
import {
  useKeyVaultRollbackMutation,
  useKeyVaultRunQuery,
  useKeyVaultRunsQuery,
  useKeyVaultStatusQuery,
  useKeyVaultSyncMutation,
} from '../api/hooks'
import type { KeyVaultEnv, KeyVaultRunRecord, SecretRow } from '../api/types'
import { KeyRotationConfirm } from '../components/KeyRotationConfirm'
import { KeyRotationResult, type KeyRotationRunView } from '../components/KeyRotationResult'
import { KeyRotationRollback } from '../components/KeyRotationRollback'
import { formatTimestamp } from '../utils/format'
import pageStyles from './Page.module.css'
import styles from './KeyRotationPage.module.css'

/** The two vaults, in the order they should be worked: rehearse on UAT, then PROD. */
const ENVS: { key: KeyVaultEnv; label: string; note: string }[] = [
  { key: 'uat', label: 'UAT', note: 'kv-cicd-uat-uaenorth' },
  { key: 'prod', label: 'PROD', note: 'kv-cicd-prod-uaenorth' },
]

/** Destinations a sync would actually write, counted by definition and by kind.
 *
 * Only `behind` counts. `match` needs nothing, and `unknown` is refused rather than written -- a
 * pipeline holding a value the vault has never held is a mapping error, and a count that quietly
 * included it would promise a write that the backend is going to decline.
 *
 * The split by kind is not cosmetic. A stage variable is picked up by the next release; a Docker
 * build argument is baked into an image and needs a REBUILD. Those are different days of work, so
 * the confirmation has to state which of the two it is about to change.
 */
function syncScope(secrets: SecretRow[]) {
  const defs = new Map<
    string,
    { project: string; defId: number; defName: string; stageVariables: number; buildArguments: number }
  >()
  let stageVariables = 0
  let buildArguments = 0
  for (const secret of secrets) {
    for (const d of secret.destinations) {
      if (d.state !== 'behind') continue
      const key = `${d.project}|${d.defId}`
      let def = defs.get(key)
      if (!def) {
        def = {
          project: d.project,
          defId: d.defId,
          defName: d.defName,
          stageVariables: 0,
          buildArguments: 0,
        }
        defs.set(key, def)
      }
      if (d.kind === 'build-argument') {
        def.buildArguments += 1
        buildArguments += 1
      } else {
        def.stageVariables += 1
        stageVariables += 1
      }
    }
  }
  return {
    total: stageVariables + buildArguments,
    stageVariables,
    buildArguments,
    definitions: [...defs.values()],
  }
}

/** Which secrets are mapped to destinations the vault cannot account for, and where.
 *
 * This is the one finding on the page that stops everything. A single vault entry mapped to two
 * services that do NOT in fact share that credential means a sync would hand one of them the
 * other's value, so the banner names the secret and the services rather than saying "a problem was
 * found" -- the operator has to be able to go and look.
 */
function unknownFindings(secrets: SecretRow[]) {
  return secrets
    .filter((s) => s.counts.unknown > 0)
    .map((s) => ({
      secret: s.name,
      service: s.service,
      where: s.destinations
        .filter((d) => d.state === 'unknown')
        .map((d) => `${d.defName} (${d.project} def ${d.defId}) · ${d.stage} · ${d.variable}`),
    }))
}

/** One row of run history, which expands into the same result table a live run renders.
 *
 * Its own component so the detail query can be gated on `open` -- the list endpoint is cheap, the
 * per-run record is not, and nobody wants twenty of them fetched to draw a collapsed list.
 */
function HistoryEntry({ summary }: { summary: KeyVaultRunRecord }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, isError, error } = useKeyVaultRunQuery(open ? summary.runId : null)
  const totals = summary.totals ?? { written: 0, unchanged: 0, refused: 0, failed: 0 }

  return (
    <li className={styles.historyItem}>
      <div className={styles.historyHead}>
        <span className={styles.historyWhat}>
          <span className={summary.action === 'rollback' ? styles.tagRollback : styles.tagSync}>
            {summary.action}
          </span>
          {summary.dryRun && <span className={styles.tagDry}>preview</span>}
          <span className={styles.historyEnv}>{summary.env.toUpperCase()}</span>
        </span>
        <span className={styles.historyWho}>
          {summary.by} · {formatTimestamp(summary.at)}
        </span>
        <span className={styles.historyTotals}>
          {totals.written} written · {totals.unchanged} unchanged
          {totals.refused > 0 ? ` · ${totals.refused} refused` : ''}
          {totals.failed > 0 ? ` · ${totals.failed} failed` : ''}
        </span>
        <button
          type="button"
          className={styles.expandBtn}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>
      {open && (
        <div className={styles.historyDetail}>
          {isLoading && <p className={styles.muted}>Reading the full run record…</p>}
          {isError && (
            <p className={styles.errText}>
              Could not re-read this run ({(error as Error).message}) — showing what the history
              list returned.
            </p>
          )}
          {/* The list endpoint already returns whole records, so the fetched one is used when it
              arrives and the list row stands in until then -- a history row never sits empty. */}
          <KeyRotationResult run={data ?? summary} heading={`Run ${summary.runId}`} />
        </div>
      )}
    </li>
  )
}

/** Key rotation — Key Vault out to the Azure DevOps release definitions, and back again.
 *
 * Every CI/CD credential lives in Key Vault, and every pipeline holds its own copy. Rotating one by
 * hand means finding each copy; SENTRY_AUTH_TOKEN alone has 19 of them across 9 definitions, and
 * missing one fails silently. This screen does the whole sweep in one click, and undoes it in one
 * click, and -- the part that actually matters -- says exactly which variable in which definition
 * changed, at which revision.
 *
 * Three constraints shape the layout, each from something real:
 *
 * 1. **No credential value is on this page, in any form.** The API returns 10-character SHA-256
 *    prefixes, character lengths and Key Vault version ids, and nothing else. There is no masked
 *    value, no first-and-last-three, no reveal button. The hash prefix is how the screen shows that
 *    two places hold the same thing without either of them being readable.
 * 2. **A sync refuses rather than guesses.** A pipeline holding a value the vault has never held is
 *    a mapping error, not a stale copy. The status endpoint reports it as `unknown`, and while any
 *    exists the Sync button is disabled and a banner says why -- because the failure mode is
 *    handing a service another service's credential, which nothing downstream would catch.
 * 3. **This writes definitions, not running services.** Nothing here touches a cluster or creates a
 *    release. A stage variable reaches the app on the next release; a build argument is baked into
 *    an image and needs a rebuild. Both the confirmation and the result table say which kind each
 *    destination is, because that is what decides whether the rotation is finished.
 */
export function KeyRotationPage() {
  const [env, setEnv] = useState<KeyVaultEnv>('uat')
  // The last run's result, held in page state rather than read back from the mutation, so it
  // survives the status refetch that follows a write and stays up until dismissed.
  const [run, setRun] = useState<KeyRotationRunView | null>(null)
  const [confirmingSync, setConfirmingSync] = useState(false)

  const status = useKeyVaultStatusQuery(env)
  // The runs endpoint is not per-environment, so the list covers both vaults and is narrowed here.
  // Showing PROD runs under a UAT heading is exactly the sort of thing that gets misread.
  const runs = useKeyVaultRunsQuery()
  const sync = useKeyVaultSyncMutation()
  const rollback = useKeyVaultRollbackMutation()

  const data = status.data
  // ok:false with a message is how the backend reports "no workload identity, no vault" -- the same
  // shape the Logging Dashboard uses when its service principal is missing. It is not an error
  // state: the page still renders and says what is missing.
  const notConnected = Boolean(data && data.ok === false)
  const secrets = data?.secrets ?? []
  const services = data?.services ?? []
  const totals = data?.totals
  const blocked = Boolean(data?.blocked)

  const scope = useMemo(() => syncScope(secrets), [secrets])
  const findings = useMemo(() => unknownFindings(secrets), [secrets])
  /** How many destinations in this environment are build arguments, i.e. baked into an image.
   * Counted from the plan rather than written into the copy: the number moves whenever a definition
   * changes, and a stale figure in a production warning is worse than no figure. */
  const bakedIn = useMemo(
    () =>
      secrets.reduce(
        (n, s) => n + s.destinations.filter((d) => d.kind === 'build-argument').length,
        0,
      ),
    [secrets],
  )

  // Newest first is the backend's order; only the environment on screen is shown.
  const history = useMemo(
    () => (runs.data?.items ?? []).filter((r) => r.env === env),
    [runs.data, env],
  )

  const busy = sync.isPending || rollback.isPending
  const isProd = env === 'prod'

  function switchEnv(next: KeyVaultEnv) {
    if (next === env) return
    setEnv(next)
    // A result from the other vault left on screen under a new environment heading is the kind of
    // thing that gets read as "this just happened on PROD".
    setRun(null)
    setConfirmingSync(false)
  }

  async function runSync(dryRun: boolean) {
    setConfirmingSync(false)
    try {
      const r = await sync.mutateAsync({ env, services: null, dryRun })
      setRun({ ...r, env, action: 'sync' })
    } catch (err) {
      // A transport-level failure is not a run record, so it is reported as a message rather than
      // being dressed up as a result table with zero rows.
      setRun({
        ok: false,
        runId: '(not started)',
        dryRun,
        action: 'sync',
        env,
        message: (err as Error).message,
        totals: { written: 0, unchanged: 0, refused: 0, failed: 0 },
        refused: [],
        results: [],
      })
    }
    // No refetch here: the mutation hook invalidates the run history itself on success, and a
    // request that never reached the backend recorded no run to go and read.
  }

  async function runRollback(selected: string[], dryRun: boolean) {
    try {
      const r = await rollback.mutateAsync({ env, services: selected, secrets: null, dryRun })
      setRun({ ...r, env, action: 'rollback' })
    } catch (err) {
      setRun({
        ok: false,
        runId: '(not started)',
        dryRun,
        action: 'rollback',
        env,
        message: (err as Error).message,
        totals: { written: 0, unchanged: 0, refused: 0, failed: 0 },
        refused: [],
        results: [],
      })
    }
  }

  return (
    <main className={`${pageStyles.main} ${isProd ? styles.prodPage : ''}`}>
      <div className={pageStyles.pageHead}>
        <div>
          <h1 className={pageStyles.pageTitle}>
            Key Rotation
            {isProd && <span className={styles.prodPill}>Production</span>}
          </h1>
          <p className={pageStyles.pageSubtitle}>
            Push every credential from Key Vault into the pipelines that read it, and roll the whole
            set — or one service — back to the previous version. Writes release{' '}
            <strong>definitions</strong> only: nothing reaches a running service until somebody
            creates a release.
          </p>
        </div>
        <div className={styles.envSwitch} role="group" aria-label="Environment">
          {ENVS.map((e) => (
            <button
              key={e.key}
              type="button"
              className={`${styles.envBtn} ${env === e.key ? styles.envBtnOn : ''} ${
                e.key === 'prod' ? styles.envBtnProd : ''
              }`}
              aria-pressed={env === e.key}
              onClick={() => switchEnv(e.key)}
            >
              <span className={styles.envLabel}>{e.label}</span>
              <span className={styles.envNote}>{e.note}</span>
            </button>
          ))}
        </div>
      </div>

      {/* PROD has to read differently from UAT before anything is clicked, not after. */}
      {isProd && (
        <p className={styles.prodWarn}>
          <strong>This is the production vault.</strong>{' '}
          {bakedIn > 0 ? (
            <>
              {bakedIn} of these destinations are Docker build arguments baked into images, so a
              rotation here is finished only once those images are rebuilt — a redeploy will not
              pick them up.
            </>
          ) : (
            <>
              A rotation here is finished only once a release carries the new values out; writing
              the definitions is the first half of the job, not the whole of it.
            </>
          )}
        </p>
      )}

      {status.isLoading && <p className={pageStyles.loading}>Reading Key Vault and the pipelines…</p>}
      {status.isError && (
        <p className={pageStyles.error}>{(status.error as Error).message}</p>
      )}

      {notConnected && (
        <div className={styles.notConnected} role="status">
          <strong>Not connected to Key Vault.</strong> {data?.message} Nothing on this page can be
          read or written until the portal's managed identity can reach the vault.
        </div>
      )}

      {data && !notConnected && (
        <>
          {/* ---- Summary strip ------------------------------------------------------------- */}
          <section className={styles.summary} aria-label="Summary">
            <dl className={styles.tiles}>
              <div className={styles.tile}>
                <dt>Secrets</dt>
                <dd>{totals?.secrets ?? 0}</dd>
              </div>
              <div className={styles.tile}>
                <dt>Values loaded</dt>
                <dd>{totals?.filled ?? 0}</dd>
              </div>
              <div
                className={`${styles.tile} ${(totals?.placeholders ?? 0) > 0 ? styles.tileWarn : ''}`}
              >
                <dt>Placeholders</dt>
                <dd>{totals?.placeholders ?? 0}</dd>
              </div>
              <div className={styles.tile}>
                <dt>Destinations matching</dt>
                <dd>
                  {totals?.match ?? 0}
                  <span className={styles.tileOf}>of {totals?.destinations ?? 0}</span>
                </dd>
              </div>
              <div className={`${styles.tile} ${(totals?.behind ?? 0) > 0 ? styles.tileInfo : ''}`}>
                <dt>Behind</dt>
                <dd>{totals?.behind ?? 0}</dd>
              </div>
              <div className={`${styles.tile} ${(totals?.unknown ?? 0) > 0 ? styles.tileBad : ''}`}>
                <dt>Unrecognised</dt>
                <dd>{totals?.unknown ?? 0}</dd>
              </div>
            </dl>
            <p className={styles.readAt}>
              {data.vault} · read {formatTimestamp(data.generatedAt)}
              {status.isFetching && ' · refreshing…'}
              <button
                type="button"
                className={styles.refreshBtn}
                onClick={() => void status.refetch()}
                disabled={status.isFetching}
              >
                {status.isFetching ? 'Refreshing…' : 'Re-read now'}
              </button>
            </p>
          </section>

          {/* ---- The one finding that stops a sync ----------------------------------------- */}
          {blocked && (
            <div className={styles.blockBanner} role="alert">
              <h2 className={styles.blockTitle}>Sync is blocked — a credential is mapped wrongly</h2>
              <p className={styles.blockBody}>
                {findings.length === 1 ? 'One vault entry is' : `${findings.length} vault entries are`}{' '}
                mapped to pipelines holding a value this vault has never held. That means the entry
                is pointed at services which do not actually share the credential, so a sync would
                overwrite one service with another's value. Fix the mapping in the plan file first;
                Sync stays disabled until every destination is accounted for.
              </p>
              <ul className={styles.blockList}>
                {findings.map((f) => (
                  <li key={f.secret}>
                    <span className={styles.mono}>{f.secret}</span>
                    <span className={styles.blockService}> (service: {f.service})</span>
                    <ul className={styles.blockWhere}>
                      {f.where.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- Sync ---------------------------------------------------------------------- */}
          <section className={styles.syncSection} aria-labelledby="keyrotation-sync-title">
            <h2 id="keyrotation-sync-title" className={styles.sectionTitle}>
              Sync vault to pipelines
            </h2>
            <p className={styles.sectionLede}>
              Writes the current Key Vault value into every pipeline destination that is behind it.
              Destinations already holding the current value are left alone, and anything the vault
              cannot account for is refused rather than overwritten.
            </p>
            <div className={styles.syncState}>
              {scope.total === 0 ? (
                <span className={styles.inSync}>
                  Every destination already holds the current vault value — a sync would change
                  nothing.
                </span>
              ) : (
                <span className={styles.outOfSync}>
                  <strong>{scope.total}</strong> destination{scope.total === 1 ? '' : 's'} behind the
                  vault, across <strong>{scope.definitions.length}</strong> definition
                  {scope.definitions.length === 1 ? '' : 's'} — {scope.stageVariables} release-stage
                  variable{scope.stageVariables === 1 ? '' : 's'} and {scope.buildArguments} Docker
                  build argument{scope.buildArguments === 1 ? '' : 's'}.
                </span>
              )}
            </div>
            <div className={styles.actions}>
              {/* Preview is the safe twin of the button beside it: same endpoint, dryRun true,
                  identical table, nothing written. Offered first so it is the one under the
                  cursor. */}
              {/* Still offered while Sync is blocked: it writes nothing, and it is the quickest way
                  to see exactly which destinations the backend is refusing and why. */}
              <button
                type="button"
                className={styles.previewBtn}
                disabled={busy}
                onClick={() => void runSync(true)}
              >
                Preview
              </button>
              <button
                type="button"
                className={styles.syncBtn}
                disabled={busy || blocked || scope.total === 0}
                onClick={() => setConfirmingSync(true)}
                title={
                  blocked
                    ? 'Disabled while a credential is mapped to services that do not share it'
                    : undefined
                }
              >
                {sync.isPending ? 'Syncing…' : 'Sync vault to pipelines'}
              </button>
            </div>
          </section>

          {/* ---- Rollback ------------------------------------------------------------------ */}
          <KeyRotationRollback
            env={env}
            services={services}
            secrets={secrets}
            busy={busy}
            onRun={(selected, dryRun) => void runRollback(selected, dryRun)}
          />

          {/* ---- What just happened -------------------------------------------------------- */}
          {run && <KeyRotationResult run={run} onDismiss={() => setRun(null)} />}

          {/* ---- Run history --------------------------------------------------------------- */}
          <section className={styles.historySection} aria-labelledby="keyrotation-history-title">
            <h2 id="keyrotation-history-title" className={styles.sectionTitle}>
              Recent runs
            </h2>
            {runs.isLoading && <p className={styles.muted}>Reading run history…</p>}
            {runs.isError && (
              <p className={styles.errText}>
                Could not read run history: {(runs.error as Error).message}
              </p>
            )}
            {runs.data && history.length === 0 && (
              <p className={styles.muted}>
                No sync or rollback has been run on {env.toUpperCase()} yet.
              </p>
            )}
            {history.length > 0 && (
              <ul className={styles.historyList}>
                {history.map((r) => (
                  <HistoryEntry key={r.runId} summary={r} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {confirmingSync && (
        <KeyRotationConfirm
          title={`Write ${scope.total} destination${scope.total === 1 ? '' : 's'} on ${env.toUpperCase()}?`}
          confirmLabel={`Write ${scope.total} destination${scope.total === 1 ? '' : 's'}`}
          busy={sync.isPending}
          onCancel={() => setConfirmingSync(false)}
          onConfirm={() => void runSync(false)}
        >
          <p>
            {scope.stageVariables} release-stage variable
            {scope.stageVariables === 1 ? '' : 's'} and {scope.buildArguments} Docker build argument
            {scope.buildArguments === 1 ? '' : 's'} will be set to the current vault value, across
            these {scope.definitions.length} definition{scope.definitions.length === 1 ? '' : 's'}:
          </p>
          <ul className={styles.confirmList}>
            {scope.definitions.map((d) => (
              <li key={`${d.project}-${d.defId}`}>
                <strong>{d.defName}</strong>{' '}
                <span className={styles.muted}>
                  ({d.project} def {d.defId})
                </span>{' '}
                — {d.stageVariables} stage variable{d.stageVariables === 1 ? '' : 's'},{' '}
                {d.buildArguments} build argument{d.buildArguments === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
          <p className={styles.confirmNote}>
            A stage variable takes effect on the next release. A build argument is baked into the
            image, so those {scope.buildArguments === 1 ? 'one needs' : `${scope.buildArguments} need`}{' '}
            a rebuild rather than a redeploy.
          </p>
        </KeyRotationConfirm>
      )}
    </main>
  )
}
