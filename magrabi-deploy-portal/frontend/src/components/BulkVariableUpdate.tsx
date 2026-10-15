import { useEffect, useMemo, useState } from 'react'
import {
  useEnvVarFindQuery,
  useEnvVarsBulkUpdateMutation,
  useEnvVarsCreateMutation,
} from '../api/hooks'
import type { BulkUpdateResult, CreateVarResult } from '../api/types'
import styles from './BulkVariableUpdate.module.css'

const ENVS = ['DEV', 'SIT', 'UAT', 'BETA', 'PROD'] as const

type Row = { pipeline: string; ok: boolean; message?: string; detail?: string; rev?: string }

/** Find one variable across the working set, then update it -- the same value everywhere, or a
 * different one per pipeline -- or create it where it does not exist yet.
 *
 * Scope defaults to the ~14 pipelines the team actually works on rather than all 31 registered
 * ones: a search is one full release-definition read per pipeline, and scanning everything made the
 * screen too slow to use. "Search everything" is still one checkbox away.
 *
 * Current values are shown per pipeline because the same variable legitimately differs between
 * them -- a DSN or endpoint usually does -- so a single shared "set them all to X" box would be
 * wrong on its own. Both are offered: fill "set all", or edit rows individually, or mix the two.
 */
export function BulkVariableUpdate() {
  const [name, setName] = useState('')
  const [env, setEnv] = useState<string>('SIT')
  const [searchAll, setSearchAll] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [perValue, setPerValue] = useState<Record<string, string>>({})
  const [setAll, setSetAll] = useState('')
  const [reveal, setReveal] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [results, setResults] = useState<Row[] | null>(null)

  // Create mode
  const [creating, setCreating] = useState(false)
  const [newTarget, setNewTarget] = useState<'stage' | 'buildArg'>('stage')
  const [newValue, setNewValue] = useState('')
  const [createTargets, setCreateTargets] = useState<Set<string>>(new Set())

  const find = useEnvVarFindQuery(
    name.trim(),
    env,
    searching && name.trim().length > 0,
    searchAll ? 'all' : undefined,
  )
  const bulk = useEnvVarsBulkUpdateMutation()
  const create = useEnvVarsCreateMutation()

  const found = useMemo(() => find.data?.found ?? [], [find.data])
  const notFound = useMemo(() => find.data?.notFound ?? [], [find.data])
  const isSecret = found[0]?.isSecret ?? /secret|token|password|key/i.test(name)

  // Default every found pipeline to selected -- the common case is "all of them".
  useEffect(() => {
    if (found.length) setSelected(new Set(found.map((f) => f.pipeline)))
  }, [found])

  const chosen = useMemo(() => found.filter((f) => selected.has(f.pipeline)), [found, selected])

  function effectiveValue(pipeline: string): string {
    if (pipeline in perValue) return perValue[pipeline]
    return setAll
  }

  const readyCount = chosen.filter((c) => effectiveValue(c.pipeline) !== '').length

  function runSearch() {
    setResults(null)
    setPerValue({})
    setSetAll('')
    setSearching(true)
  }

  function toggle(p: string, into: Set<string>, setter: (s: Set<string>) => void) {
    const next = new Set(into)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setter(next)
  }

  function writeUpdates() {
    const targets = chosen.filter((c) => effectiveValue(c.pipeline) !== '')
    const values: Record<string, Record<string, string>> = {}
    for (const t of targets) values[t.pipeline] = { [name.trim()]: effectiveValue(t.pipeline) }
    bulk.mutate(
      {
        pipelines: targets.map((t) => t.pipeline),
        env,
        // The shared value is the fallback; `values` overrides it per pipeline.
        changes: [{ name: name.trim(), value: setAll || effectiveValue(targets[0].pipeline), source: '' }],
        values,
      },
      {
        onSuccess: (r) => {
          setConfirming(false)
          setResults(
            r.results.map((x: BulkUpdateResult) => ({
              pipeline: x.pipeline,
              ok: x.ok,
              message: x.message,
              detail: x.changed?.map((c) => c.source).join(', '),
              rev: x.revisionBefore != null ? `${x.revisionBefore} → ${x.revisionAfter}` : undefined,
            })),
          )
          setPerValue({})
          setSetAll('')
        },
        onError: (err) => {
          setConfirming(false)
          setResults([{ pipeline: '(request)', ok: false, message: (err as Error).message }])
        },
      },
    )
  }

  function writeCreate() {
    create.mutate(
      {
        pipelines: [...createTargets],
        env,
        name: name.trim(),
        value: newValue,
        target: newTarget,
      },
      {
        onSuccess: (r) => {
          setCreating(false)
          setNewValue('')
          setResults(
            r.results.map((x: CreateVarResult) => ({
              pipeline: x.pipeline,
              ok: x.ok,
              message: x.message,
              detail: x.createdIn,
              rev: x.revisionBefore != null ? `${x.revisionBefore} → ${x.revisionAfter}` : undefined,
            })),
          )
        },
        onError: (err) => {
          setCreating(false)
          setResults([{ pipeline: '(request)', ok: false, message: (err as Error).message }])
        },
      },
    )
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span>Variable name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="SENTRY_AUTH_TOKEN"
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
        </label>
        <label className={styles.field}>
          <span>Environment</span>
          <select
            value={env}
            onChange={(e) => {
              setEnv(e.target.value)
              setSearching(false)
              setResults(null)
            }}
          >
            {ENVS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <button
          className={styles.findButton}
          onClick={runSearch}
          disabled={!name.trim() || find.isFetching}
        >
          {find.isFetching ? 'Searching…' : 'Find'}
        </button>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={searchAll}
            onChange={(e) => {
              setSearchAll(e.target.checked)
              setSearching(false)
            }}
          />
          Search every pipeline (slower)
        </label>
      </div>

      {find.isError && <p className={styles.err}>{(find.error as Error).message}</p>}

      {find.data && (
        <>
          <p className={styles.summary}>
            <strong>{found.length}</strong> of {find.data.total} pipelines define{' '}
            <code>{find.data.name}</code> on <strong>{find.data.env}</strong>
            {!searchAll && <span className={styles.src}> · working set</span>}
          </p>

          {found.length > 0 && (
            <>
              <div className={styles.setAllRow}>
                <label className={styles.field}>
                  <span>Set all selected to</span>
                  <input
                    className={styles.valueInput}
                    type={isSecret && !reveal ? 'password' : 'text'}
                    value={setAll}
                    onChange={(e) => setSetAll(e.target.value)}
                    placeholder="one value for every selected pipeline"
                    autoComplete="new-password"
                  />
                </label>
                {isSecret && (
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={reveal}
                      onChange={(e) => setReveal(e.target.checked)}
                    />
                    Show values
                  </label>
                )}
              </div>

              <div className={styles.listBox}>
                <div className={styles.listHead}>
                  <label className={styles.selectAll}>
                    <input
                      type="checkbox"
                      checked={selected.size === found.length && found.length > 0}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(found.map((f) => f.pipeline)) : new Set(),
                        )
                      }
                    />
                    Select all
                  </label>
                  <span className={styles.chosenCount}>
                    {selected.size} selected · {readyCount} with a value
                  </span>
                </div>
                {found.map((f) => {
                  const overridden = f.pipeline in perValue
                  return (
                    <div key={f.pipeline} className={styles.item}>
                      <input
                        type="checkbox"
                        checked={selected.has(f.pipeline)}
                        onChange={() => toggle(f.pipeline, selected, setSelected)}
                      />
                      <span className={styles.pipeline}>{f.pipeline}</span>
                      <span className={styles.badge}>{f.project}</span>
                      <span className={styles.stage}>{f.stageName}</span>
                      <span className={styles.current} title={f.value ?? ''}>
                        {f.value == null ? (
                          <em>withheld</em>
                        ) : isSecret && !reveal ? (
                          '••••••••'
                        ) : (
                          f.value || <em>(empty)</em>
                        )}
                      </span>
                      <input
                        className={`${styles.rowInput} ${overridden ? styles.rowInputEdited : ''}`}
                        type={isSecret && !reveal ? 'password' : 'text'}
                        value={overridden ? perValue[f.pipeline] : ''}
                        placeholder={setAll ? 'using “set all”' : 'leave blank to skip'}
                        onChange={(e) =>
                          setPerValue((prev) => ({ ...prev, [f.pipeline]: e.target.value }))
                        }
                        autoComplete="new-password"
                      />
                      {overridden && (
                        <button
                          className={styles.undo}
                          onClick={() =>
                            setPerValue((prev) => {
                              const next = { ...prev }
                              delete next[f.pipeline]
                              return next
                            })
                          }
                        >
                          undo
                        </button>
                      )}
                      <span className={styles.src}>{(f.sources ?? []).join(', ')}</span>
                    </div>
                  )
                })}
              </div>

              <div className={styles.actionRow}>
                <button
                  className={styles.writeButton}
                  disabled={!readyCount || bulk.isPending}
                  onClick={() => setConfirming(true)}
                >
                  {bulk.isPending
                    ? 'Writing…'
                    : `Update ${readyCount} pipeline${readyCount === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}

          {notFound.length > 0 && (
            <details className={styles.details}>
              <summary>
                {notFound.length} pipeline(s) do not define it here — you can create it
              </summary>
              <div className={styles.listBox}>
                {notFound.map((f) => (
                  <label key={f.pipeline} className={styles.item}>
                    <input
                      type="checkbox"
                      checked={createTargets.has(f.pipeline)}
                      onChange={() => toggle(f.pipeline, createTargets, setCreateTargets)}
                    />
                    <span className={styles.pipeline}>{f.pipeline}</span>
                    <span className={styles.src}>{f.reason}</span>
                  </label>
                ))}
              </div>
              <div className={styles.setAllRow}>
                <label className={styles.field}>
                  <span>Add to section</span>
                  <select
                    value={newTarget}
                    onChange={(e) => setNewTarget(e.target.value as 'stage' | 'buildArg')}
                  >
                    <option value="stage">Stage variable (release time)</option>
                    <option value="buildArg">Docker build argument (baked into the image)</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Value</span>
                  <input
                    className={styles.valueInput}
                    type={isSecret && !reveal ? 'password' : 'text'}
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <button
                  className={styles.writeButton}
                  disabled={!createTargets.size || !newValue || !name.trim() || create.isPending}
                  onClick={() => setCreating(true)}
                >
                  {create.isPending ? 'Creating…' : `Create on ${createTargets.size}`}
                </button>
              </div>
              <p className={styles.note}>
                The two sections behave differently and putting a value in the wrong one fails
                silently: a <strong>stage variable</strong> is substituted at release time, a{' '}
                <strong>build argument</strong> is baked into the image at build time. Several of
                these pipelines hardcode their configuration in the Docker build, so that is often
                the one you want.
              </p>
            </details>
          )}
        </>
      )}

      {results && (
        <div className={styles.results}>
          <h3 className={styles.resultsTitle}>Result</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Outcome</th>
                <th>Revision</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.pipeline}>
                  <td className={styles.pipeline}>{r.pipeline}</td>
                  <td className={r.ok ? styles.ok : styles.bad}>
                    {r.ok ? `done · ${r.detail ?? ''}` : r.message}
                  </td>
                  <td className={styles.src}>{r.rev ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.note}>
            Applies to <strong>new</strong> releases. Anything already built keeps the value it was
            created with and needs a fresh release to pick this up.
          </p>
        </div>
      )}

      {(confirming || creating) && (
        <div
          className={styles.backdrop}
          onClick={() => {
            setConfirming(false)
            setCreating(false)
          }}
          role="presentation"
        >
          <div
            className={styles.dialog}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2 className={styles.dialogTitle}>
              {creating ? 'Create' : 'Write'} {name.trim()} on{' '}
              {creating ? createTargets.size : readyCount} pipeline(s)?
            </h2>
            <p className={styles.dialogMeta}>
              Environment: <strong>{env}</strong>
              {creating && (
                <>
                  {' '}
                  · Section:{' '}
                  <strong>
                    {newTarget === 'stage' ? 'stage variable' : 'Docker build argument'}
                  </strong>
                </>
              )}
            </p>
            <ul className={styles.changeList}>
              {creating
                ? [...createTargets].map((p) => <li key={p}>{p}</li>)
                : chosen
                    .filter((c) => effectiveValue(c.pipeline) !== '')
                    .map((c) => (
                      <li key={c.pipeline}>
                        {c.pipeline}{' '}
                        <span className={styles.src}>
                          · {c.stageName}
                          {c.pipeline in perValue ? ' · own value' : ' · shared value'}
                        </span>
                      </li>
                    ))}
            </ul>
            <p className={styles.dialogNote}>
              Values are not repeated here. Each definition is written separately — if one fails the
              rest still apply, and you get a per-pipeline result.
            </p>
            <div className={styles.dialogActions}>
              <button
                className={styles.cancel}
                onClick={() => {
                  setConfirming(false)
                  setCreating(false)
                }}
              >
                Cancel
              </button>
              <button
                className={styles.confirm}
                onClick={creating ? writeCreate : writeUpdates}
                disabled={bulk.isPending || create.isPending}
              >
                {bulk.isPending || create.isPending ? 'Writing…' : creating ? 'Create' : 'Write'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
