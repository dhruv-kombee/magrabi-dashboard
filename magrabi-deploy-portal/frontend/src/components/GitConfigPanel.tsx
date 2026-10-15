import { useEffect, useMemo, useState } from 'react'
import {
  useGitConfigApplyMutation,
  useGitConfigDeployMutation,
  useGitConfigPreviewMutation,
  useGitConfigQuery,
  useIdentityQuery,
} from '../api/hooks'
import type { GitConfigApplied, GitConfigFile } from '../api/types'
import styles from './GitConfigPanel.module.css'

/** Pipelines whose settings live in a repository rather than in the release definition.
 *
 * This list only decides whether to OFFER this screen. The backend registry is the authority on
 * what it can do, and answers mode:"pipeline" for anything not in it. Keeping a hint here avoids
 * reading nine repository files just to decide whether a tab should exist.
 */
export const GIT_CONFIG_PIPELINES = ['ecom saleor core']

export function isGitConfigPipeline(pipeline: string | null | undefined): boolean {
  if (!pipeline) return false
  return GIT_CONFIG_PIPELINES.includes(pipeline.trim().toLowerCase())
}

const fileName = (p: string) => p.split('/').pop() || p

/** Add a setting to a Git-backed pipeline, and deploy it, without leaving the portal.
 *
 * The screen is deliberately one column of numbered steps rather than tabs or a table you have to
 * interpret. The job is always the same shape -- a developer hands over a setting, it has to reach
 * some services, then two pipelines have to run in order -- so the screen is that shape too.
 */
export function GitConfigPanel({ pipeline, env }: { pipeline: string; env: string }) {
  const { data, isLoading, isError, error, refetch } = useGitConfigQuery(pipeline, env)
  const { data: identity } = useIdentityQuery()
  const isAdmin = identity?.role === 'admin'

  const preview = useGitConfigPreviewMutation()
  const apply = useGitConfigApplyMutation()
  const deploy = useGitConfigDeployMutation()

  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [services, setServices] = useState<string[]>([])
  const [done, setDone] = useState<GitConfigApplied | null>(null)
  const [ran, setRan] = useState<Record<string, { id: number; url: string; pinned: string }>>({})
  const [showAll, setShowAll] = useState(false)
  // Which row's value is being changed, if any. One at a time on purpose: each save is its
  // own commit and its own pull request, so a grid of pending edits would be misleading.
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null)
  const [search, setSearch] = useState('')

  const serviceFiles = useMemo(
    () =>
      (data?.files ?? []).filter(
        (f): f is GitConfigFile & { service: string } => f.role === 'deployment' && !!f.service,
      ),
    [data],
  )

  // Any edit invalidates a preview computed from the previous values, and a stale "this is what
  // will change" is worse than none at all.
  useEffect(() => {
    preview.reset()
    setDone(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, value, services, env, pipeline])

  // An in-flight row edit belongs to the environment it was started in.
  useEffect(() => { setEditing(null) }, [env, pipeline])

  const keys = data?.keys ?? []
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? keys.filter((k) => k.name.toLowerCase().includes(q)) : keys
  }, [keys, search])

  if (isLoading) return <p className={styles.muted}>Reading the settings...</p>
  if (isError) {
    return (
      <p className={styles.error}>
        Could not read the settings for {pipeline} {env}.{' '}
        {error instanceof Error ? error.message : ''}
      </p>
    )
  }
  if (data && data.mode !== 'git') {
    return <p className={styles.muted}>{data.message}</p>
  }

  const orphans = data?.orphanRefs ?? []
  const p = preview.data
  const canSubmit = Boolean(p?.ok) && !apply.isPending
  const steps = done?.applyPipelines ?? data?.applyPipelines ?? []

  const toggle = (svc: string) =>
    setServices((cur) => (cur.includes(svc) ? cur.filter((s) => s !== svc) : [...cur, svc]))

  return (
    <div className={styles.panel}>
      {/* One sentence on what is different here. Anything longer does not get read. */}
      <p className={styles.lede}>
        {pipeline} keeps its settings in the <strong>{data?.repo?.name}</strong> repository, not in
        the pipeline. Add one below and the portal writes both files, merges the change and runs the
        pipelines for you.
      </p>

      {orphans.length > 0 && (
        <section className={styles.problem}>
          <h4 className={styles.problemTitle}>
            {orphans.length} {orphans.length === 1 ? 'service is' : 'services are'} missing a setting
            on {env}
          </h4>
          <p className={styles.problemBody}>
            These services read a setting that is not in this environment's settings file, so they
            run without it. Adding it below with the same name fixes it.
          </p>
          <ul className={styles.problemList}>
            {orphans.map((o) => (
              <li key={`${o.service}-${o.key}`}>
                <strong>{o.service}</strong> wants <code>{o.key}</code>
                {isAdmin && (
                  <button
                    type="button"
                    className={styles.inlineFix}
                    onClick={() => {
                      setName(o.key)
                      setServices([])
                      setValue('')
                    }}
                  >
                    Add it
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isAdmin && (
        <section className={styles.form}>
          <h3 className={styles.formTitle}>Add a setting to {env}</h3>

          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>Name</span>
              <input
                className={styles.input}
                placeholder="ENABLE_PROMO_TIMING"
                value={name}
                onChange={(e) => setName(e.target.value.trim())}
                spellCheck={false}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Value</span>
              <input
                className={styles.input}
                placeholder="True"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
              />
            </label>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>
              Which services need it
              {/* The single most common way these changes go wrong: the setting is added but no
                  service is wired to it, so it silently does nothing. */}
              <span className={styles.hint}>
                If the developer did not say, ask. A setting no service reads does nothing.
              </span>
            </span>
            <div className={styles.checks}>
              {serviceFiles.map((f) => (
                <label
                  key={f.service}
                  className={`${styles.check} ${services.includes(f.service) ? styles.checkOn : ''} ${
                    f.canInsert === false ? styles.checkDisabled : ''
                  }`}
                  title={f.canInsert === false ? f.insertNote : undefined}
                >
                  <input
                    type="checkbox"
                    checked={services.includes(f.service)}
                    disabled={f.canInsert === false}
                    onChange={() => toggle(f.service)}
                  />
                  {f.service}
                </label>
              ))}
            </div>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.check1}
              disabled={!name || !value || services.length === 0 || preview.isPending}
              onClick={() =>
                preview.mutate({ pipeline, env, name, value, services })
              }
            >
              {preview.isPending ? 'Checking...' : 'Check this change'}
            </button>
            {(name || value || services.length > 0) && (
              <button
                type="button"
                className={styles.clear}
                onClick={() => {
                  setName('')
                  setValue('')
                  setServices([])
                }}
              >
                Clear
              </button>
            )}
          </div>

          {preview.isError && (
            <p className={styles.error}>
              {preview.error instanceof Error ? preview.error.message : 'Could not check.'}
            </p>
          )}

          {p && (
            <div className={styles.result}>
              {p.problems.length > 0 && (
                <div className={styles.stop}>
                  {p.problems.map((x) => (
                    <p key={x}>{x}</p>
                  ))}
                </div>
              )}
              {p.already.length > 0 && (
                <p className={styles.note}>
                  Already in place: {p.already.join(' ')} Only what is missing will be added.
                </p>
              )}
              {p.files.length > 0 && (
                <>
                  <h4 className={styles.resultTitle}>
                    Two things have to happen for a setting to work, and this does both
                  </h4>
                  <ul className={styles.fileList}>
                    {p.files.map((f) => (
                      <li key={f.path}>
                        <span className={styles.fileWhat}>
                          {f.role === 'configmap'
                            ? 'Stores the value'
                            : `Lets ${f.service} see it`}
                        </span>
                        <span className={styles.dim}>
                          {f.role === 'configmap'
                            ? 'The setting and its value are written into the shared settings file. ' +
                              'On its own this does nothing -- no service is looking at it yet.'
                            : `${f.service} is told to read this setting when it starts. Without ` +
                              'this line the service never sees the value, however correct it is.'}
                        </span>
                        <code className={styles.filePath}>{fileName(f.path)}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {p.sharedWithStages.length > 0 && p.files.some((f) => f.role === 'deployment') && (
                <p className={styles.caution}>
                  The service files are shared with {p.sharedWithStages.join(' and ')}, so those
                  environments will carry this line too on their next release. That is harmless on
                  its own: each environment reads its own value, and there is no value there yet.
                  To actually switch it on for {p.sharedWithStages.join(' or ')}, come back with the
                  environment set to that one and add it there as well.
                </p>
              )}
              {p.ok && (
                <p className={styles.note}>
                  {p.willAutoMerge
                    ? 'The portal will commit and merge this for you.'
                    : 'This is production. The portal will raise the change, but somebody has to approve it before it can be deployed.'}
                </p>
              )}

              <button
                type="button"
                className={styles.go}
                disabled={!canSubmit}
                onClick={() =>
                  apply.mutate(
                    { pipeline, env, name, value, services },
                    { onSuccess: (r) => setDone(r) },
                  )
                }
              >
                {apply.isPending ? 'Adding...' : `Add ${name || 'this setting'} to ${env}`}
              </button>
            </div>
          )}

          {apply.isError && (
            <p className={styles.error}>
              {apply.error instanceof Error ? apply.error.message : 'Could not add it.'}
            </p>
          )}
        </section>
      )}

      {done && (
        <section className={styles.done}>
          <h3 className={styles.doneTitle}>
            {done.merged ? `${done.name} is in ${done.env}` : `${done.name} is waiting for approval`}
          </h3>
          <p className={styles.note}>
            {done.mergeNote}{' '}
            <a href={done.url} target="_blank" rel="noreferrer" className={styles.link}>
              View the change
            </a>
          </p>

          <h4 className={styles.resultTitle}>
            {done.canDeploy ? 'Now run these, in this order' : 'Then run these, in this order'}
          </h4>
          <ol className={styles.steps}>
            {steps.map((s, i) => {
              const key = s.purpose
              const started = ran[key]
              const blocked = i > 0 && !ran[steps[i - 1].purpose]
              return (
                <li key={`${s.definitionId}-${s.stage}`}>
                  <span className={styles.stepNum}>{i + 1}</span>
                  <span className={styles.stepBody}>
                    <strong>
                      {s.purpose === 'configmap'
                        ? 'Apply the settings file'
                        : 'Restart the services with it'}
                    </strong>
                    <span className={styles.dim}>
                      {s.name}, stage {s.stage}
                      {s.needsApproval ? ' - needs an approval' : ''}
                    </span>
                    {started ? (
                      <a
                        href={started.url}
                        target="_blank"
                        rel="noreferrer"
                        className={styles.link}
                      >
                        Started. Watch it ({started.pinned})
                      </a>
                    ) : done.canDeploy ? (
                      <button
                        type="button"
                        className={styles.run}
                        disabled={blocked || deploy.isPending}
                        title={
                          blocked ? 'Run the settings file first, or the services start without it.' : undefined
                        }
                        onClick={() =>
                          deploy.mutate(
                            { pipeline, env, purpose: key },
                            {
                              onSuccess: (r) => {
                                if (r.ok && r.releaseId) {
                                  setRan((cur) => ({
                                    ...cur,
                                    [key]: {
                                      id: r.releaseId as number,
                                      url: r.url as string,
                                      pinned: r.pinned as string,
                                    },
                                  }))
                                }
                              },
                            },
                          )
                        }
                      >
                        {deploy.isPending ? 'Starting...' : 'Run it'}
                      </button>
                    ) : (
                      <span className={styles.dim}>Start this one in Azure DevOps.</span>
                    )}
                  </span>
                </li>
              )
            })}
          </ol>
          {deploy.isError && (
            <p className={styles.error}>
              {deploy.error instanceof Error ? deploy.error.message : 'Could not start it.'}
            </p>
          )}
          {!done.canDeploy && (
            <p className={styles.note}>
              The portal does not start production releases. Once the change is approved, run the
              two pipelines above in Azure DevOps, settings file first.
            </p>
          )}
        </section>
      )}

      {/* The existing settings are reference material, not the job, so they sit at the bottom
          folded away rather than being the first thing on screen. */}
      <section className={styles.block}>
        <button type="button" className={styles.disclose} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Hide' : 'Show'} the {keys.length} settings already on {env}
        </button>
        {showAll && (
          <>
            <input
              className={styles.search}
              placeholder="Filter by name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Read by</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((k) => {
                    const isEditing = editing?.name === k.name
                    // A folded block value ("ALLOWED_CLIENT_HOSTS: >-") lives on the lines BELOW
                    // its key, so it cannot be edited as a single field. The backend refuses these
                    // too; disabling here just avoids offering something that would be rejected.
                    const block = k.value !== null && /^[>|][-+]?$/.test(String(k.value).trim())
                    const editable = isAdmin && k.value !== null && !block
                    return (
                      <tr key={k.name}>
                        <td className={styles.name}>{k.name}</td>
                        <td className={k.isSecret ? styles.secret : styles.value}>
                          {isEditing ? (
                            <div className={styles.editRow}>
                              <input
                                className={styles.editInput}
                                value={editing.value}
                                autoFocus
                                onChange={(e) =>
                                  setEditing({ name: k.name, value: e.target.value })
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') setEditing(null)
                                }}
                              />
                              <button
                                type="button"
                                className={styles.saveBtn}
                                disabled={apply.isPending || editing.value === k.value}
                                onClick={() =>
                                  apply.mutate(
                                    {
                                      pipeline,
                                      env,
                                      op: 'setValue',
                                      name: k.name,
                                      value: editing.value,
                                      services: [],
                                    },
                                    {
                                      onSuccess: (r) => {
                                        setDone(r)
                                        setEditing(null)
                                      },
                                    },
                                  )
                                }
                              >
                                {apply.isPending ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                type="button"
                                className={styles.clear}
                                onClick={() => setEditing(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : k.value === null ? (
                            <span className={styles.withheld}>withheld</span>
                          ) : (
                            <>
                              {k.value}
                              {editable && (
                                <button
                                  type="button"
                                  className={styles.editBtn}
                                  onClick={() =>
                                    setEditing({ name: k.name, value: String(k.value) })
                                  }
                                >
                                  Change
                                </button>
                              )}
                              {block && <span className={styles.dim}>edit this one in Azure DevOps</span>}
                            </>
                          )}
                        </td>
                        <td className={styles.usedBy}>
                          {k.usedBy.length === 0 ? (
                            <span className={styles.nobody}>nothing reads this</span>
                          ) : k.usedBy.length === serviceFiles.length ? (
                            'every service'
                          ) : (
                            k.usedBy.join(', ')
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <button type="button" className={styles.refresh} onClick={() => refetch()}>
              Refresh
            </button>
          </>
        )}
      </section>
    </div>
  )
}
