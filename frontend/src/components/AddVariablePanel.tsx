import { useMemo, useState } from 'react'
import { useEnvVarsCreateMutation } from '../api/hooks'
import type { EnvVarEntry } from '../api/types'
import styles from './AddVariablePanel.module.css'

/** ADO resolves `$(NAME)` style references only for names shaped like this, and a shell only
 * exports names shaped like this. A name that fails it does not error -- it simply never resolves --
 * so it is rejected here. Mirrors the identical backend check, which stays the real guard. */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type Target = 'auto' | 'stage' | 'buildArg' | 'scriptExport' | 'yamlPlaceholder'

type Draft = {
  id: string
  name: string
  value: string
  target: Target | ''
  taskName: string
  /** Set after a failed submit so the row can explain itself instead of vanishing. */
  error?: string
}

let draftSeq = 0
function blankDraft(): Draft {
  draftSeq += 1
  return { id: `d${draftSeq}`, name: '', value: '', target: 'auto', taskName: '' }
}

export interface AddVariablePanelProps {
  /** Every pipeline the variable will be created on. One in browse mode, several in comparison
   * mode -- the backend already accepts a list and reports per pipeline, so adding across a
   * selection is the same call, not a new one. */
  pipelines: string[]
  env: string
  /** ADO's real stage name, for the description line -- the portal bucket ("PROD") and the stage
   * ("PROD_TAG") are often different, and the message should name the one being written to. */
  stageName?: string
  /** Docker tasks that can take a build argument. Empty disables that target. */
  buildArgTasks: string[]
  /** Tasks with an inline script that can take an `export` line. Empty disables that target. */
  scriptTasks: string[]
  /** The task that rewrites deploy-YAML placeholders, if the stage has one. Empty disables that
   * target — there is no manifest step to deliver the value through. */
  yamlTasks: string[]
  /** Everything already on this stage, so a duplicate is caught before a round trip. */
  entries: EnvVarEntry[]
}

const TARGET_HELP: Record<Target, string> = {
  auto:
    'Adds the stage variable plus every other piece this stage actually needs: the `NAME=$(NAME)` build argument that bakes it into the image, and the deploy YAML substitution that gets it into the running pod. Adding only the stage variable is the commonest way a variable looks set and does nothing. On a stage with none of those it writes a script export instead.',
  stage:
    'Substituted into the deployment YAML when a release is created. Use it for something the running container reads at start-up.',
  buildArg:
    'Baked into the image while it is built. Use it for something the app needs at compile time. It changes nothing until the next build runs.',
  scriptExport:
    'Added as an `export NAME=value` line in the stage’s script, immediately after the last existing export. Use it where the stage has no Docker task and sets everything in its script.',
  yamlPlaceholder:
    'Adds a substitution line so the deployment YAML’s NAME_VAR placeholder is replaced with this value before the manifest is applied. This is what gets a value into the RUNNING POD, and it is separate from the build argument — a variable can be correct everywhere else and still arrive as the literal text “NAME_VAR”.',
}

/** Adds variables that do not exist yet to ONE pipeline stage.
 *
 * Putting a value in the wrong section is completely silent -- nothing fails, the variable simply
 * never takes effect -- so the section is always shown:
 *
 *   Add it properly -- the default. Writes the stage variable AND the build argument referencing
 *                      it, because on their own neither one does the job. This is what almost
 *                      every real request means, and the half people forget is the second one.
 *   Stage variable  -- substituted into the deploy YAML at release time.
 *   Build argument  -- a line in the Docker task's buildArguments, baked into the image.
 *   Script export   -- an `export NAME=value` line in an inline script. Several stages have no
 *                      Docker task at all and carry everything this way.
 *
 * Rows are submitted ONE AT A TIME on purpose. Each create is a read-modify-write of the whole
 * release definition, so firing them concurrently would have them overwrite each other and only the
 * last would survive.
 */
export function AddVariablePanel({
  pipelines,
  env,
  stageName,
  buildArgTasks,
  scriptTasks,
  yamlTasks,
  entries,
}: AddVariablePanelProps) {
  const multi = pipelines.length > 1
  const [open, setOpen] = useState(false)
  const [drafts, setDrafts] = useState<Draft[]>([blankDraft()])
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const create = useEnvVarsCreateMutation()

  const canBuildArg = buildArgTasks.length > 0
  const canYaml = yamlTasks.length > 0
  const canScript = scriptTasks.length > 0

  /** Existing rows keyed by SOURCE + name, so a duplicate can be judged per target.
   *
   * The same name legitimately exists as both a stage variable (holding the value) and a build
   * argument that consumes it as $(NAME). Treating any name already on the stage as a duplicate
   * blocked exactly that, which is the commonest reason to add a build argument at all. */
  const existingBySource = useMemo(
    () => new Set(entries.map((e) => `${e.source.toLowerCase()}|${e.name.toLowerCase()}`)),
    [entries],
  )
  /** Names present anywhere on the stage. Not a blocker -- used only to explain what is already
   * there, because "this exists as a stage variable" is useful context when adding a build arg. */
  const namesAnywhere = useMemo(
    () => new Map(entries.map((e) => [e.name.toLowerCase(), e.source])),
    [entries],
  )

  /** The source string the backend will actually write to, so the check and the write agree.
   * A blank task means the backend picks the first task that accepts one -- which is the first
   * entry of the matching list, built in the same order. */
  function targetSource(d: Draft): string | null {
    // 'auto' writes the stage variable first, so that is the row a duplicate would collide with --
    // unless the stage has no Docker task, where the backend writes a script export instead.
    if (d.target === 'auto')
      return canBuildArg || canYaml
        ? 'stage variable'
        : `script export (${scriptTasks[0] || ''})`.toLowerCase()
    // The table does not list deploy-YAML substitutions, so there is nothing to collide with here.
    // A constant keeps two drafts of the same name from both claiming this target.
    if (d.target === 'yamlPlaceholder') return 'deploy yaml substitution'
    if (d.target === 'stage') return 'stage variable'
    if (d.target === 'buildArg')
      return `build argument (${d.taskName || buildArgTasks[0] || ''})`.toLowerCase()
    if (d.target === 'scriptExport')
      return `script export (${d.taskName || scriptTasks[0] || ''})`.toLowerCase()
    return null
  }

  function patch(id: string, next: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...next, error: undefined } : d)))
  }

  /** Why this row cannot be submitted yet, or '' if it can. */
  function rowProblem(d: Draft, all: Draft[]): string {
    const name = d.name.trim()
    if (!name && !d.value && d.target === '') return 'blank'
    if (!name) return 'Name is required.'
    if (!VALID_NAME.test(name))
      return 'Letters, digits and underscores only, starting with a letter or underscore.'
    if (d.target === '') return 'Choose where to add it.'
    const ts = targetSource(d)
    // The same name twice is only a clash when it lands in the same PLACE. Listing
    // SENTRY_ORGANIZATION once as a stage variable (holding "magrabi") and once as a build argument
    // ($(SENTRY_ORGANIZATION), handing it to the build) is the standard pattern in these pipelines,
    // not a mistake -- and checking the name alone made the queue unable to express it at all.
    if (
      all.filter(
        (o) =>
          o.name.trim().toLowerCase() === name.toLowerCase() &&
          o.target !== '' &&
          targetSource(o) === ts,
      ).length > 1
    )
      return 'Listed twice above for the same target.'
    // Case-insensitive: ADO and the shell both treat SENTRY_DSN and Sentry_Dsn as the same name.
    // Checked against the CHOSEN target only -- see existingBySource.
    // Only a hard block in single-pipeline mode, where `entries` describes the one stage being
    // written to. Across a selection the pipelines differ, so the backend is the guard -- it checks
    // each one and reports "already exists" per pipeline rather than failing the batch.
    if (!multi && ts && existingBySource.has(`${ts}|${name.toLowerCase()}`))
      return 'Already exists here. Edit it in the table below instead.'
    if (d.value === '') return 'Value is required.'
    return ''
  }

  const problems = useMemo(
    () => new Map(drafts.map((d) => [d.id, rowProblem(d, drafts)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, existingBySource, buildArgTasks, scriptTasks, yamlTasks],
  )

  const submittable = drafts.filter((d) => problems.get(d.id) === '')
  const blocked = drafts.filter((d) => {
    const p = problems.get(d.id)
    return p !== '' && p !== 'blank'
  })
  const ready = submittable.length > 0 && blocked.length === 0

  async function submit() {
    if (!ready) return
    setResult(null)
    const created: string[] = []
    const failed: Draft[] = []
    /** Landed on some pipelines but not others -- reported, never silently retried. */
    const partial: string[] = []

    // Sequential, deliberately. See the component docstring.
    for (const d of submittable) {
      const name = d.name.trim()
      try {
        const res = await create.mutateAsync({
          pipelines,
          env,
          name,
          value: d.value,
          // Never pinned across a selection: task names differ per pipeline, so each backend picks
          // its own first matching task rather than being handed one that may not exist there.
          taskName: !multi && d.target !== 'stage' && d.taskName ? d.taskName : undefined,
          target: d.target as Target,
        })
        const okOn = (res.results ?? []).filter((r) => r.ok)
        const badOn = (res.results ?? []).filter((r) => !r.ok)
        if (okOn.length) {
          created.push(
            multi
              ? `${name} on ${okOn.length}/${pipelines.length}`
              : `${name} (${okOn[0]?.createdIn ?? d.target})`,
          )
        }
        // A row only stays for correction when NOTHING landed. A partial success has already
        // changed pipelines, so re-submitting the same row would double-add on the ones that worked.
        if (badOn.length && !okOn.length) {
          failed.push({ ...d, error: badOn[0]?.message || res.message || 'Create failed.' })
        } else if (badOn.length) {
          partial.push(`${name}: ${badOn.map((r) => `${r.pipeline} (${r.message})`).join('; ')}`)
        }
      } catch (e) {
        failed.push({ ...d, error: (e as Error).message })
      }
    }

    // Successful rows go; failures stay put with their reason so they can be corrected and retried
    // without retyping. A partial success is the normal outcome and must not look like a total one.
    const untouched = drafts.filter((d) => problems.get(d.id) === 'blank')
    setDrafts(failed.length || untouched.length ? [...failed, ...untouched] : [blankDraft()])
    setResult({
      ok: failed.length === 0 && partial.length === 0,
      text:
        (created.length ? `Created ${created.join(', ')}. ` : '') +
        (failed.length ? `${failed.length} could not be created — see the rows above. ` : '') +
        (partial.length ? `Partly applied — ${partial.join(' | ')}` : ''),
    })
  }

  return (
    <section className={styles.panel}>
      <button type="button" className={styles.head} onClick={() => setOpen((v) => !v)}>
        <span>Add new variables, build arguments or script exports</span>
        <span className={styles.chevron}>{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className={styles.body}>
          <p className={styles.lede}>
            Adds things that do not exist yet on{' '}
            <strong>
              {multi ? `${pipelines.length} pipelines` : pipelines[0]} · {stageName || env}
            </strong>
            {multi ? ' — one entry is created on every selected pipeline, and each is reported separately.' : '.'}{' '}
            Editing an existing value is done in the table below instead. Like every change on this
            page, it applies to <strong>new releases</strong> — releases that already exist keep the
            values they were created with.
          </p>

          {drafts.map((d, index) => {
            const problem = problems.get(d.id) ?? ''
            const tasks = d.target === 'scriptExport' ? scriptTasks : buildArgTasks
            return (
              <div key={d.id} className={styles.draft}>
                <div className={styles.row}>
                  <label className={`${styles.field} ${styles.mono} ${problem && problem !== 'blank' ? styles.invalid : ''}`}>
                    {index === 0 && <span>Name</span>}
                    <input
                      value={d.name}
                      onChange={(e) => patch(d.id, { name: e.target.value })}
                      placeholder="SENTRY_AUTH_TOKEN"
                      spellCheck={false}
                    />
                  </label>

                  <label className={`${styles.field} ${styles.grow} ${styles.mono}`}>
                    {index === 0 && <span>Value</span>}
                    <input
                      value={d.value}
                      onChange={(e) => patch(d.id, { value: e.target.value })}
                      placeholder="value to set"
                      spellCheck={false}
                    />
                  </label>

                  <label className={styles.field}>
                    {index === 0 && <span>Add as</span>}
                    <select
                      value={d.target}
                      onChange={(e) =>
                        patch(d.id, { target: e.target.value as Target | '', taskName: '' })
                      }
                    >
                      <option value="">Choose one…</option>
                      <option value="auto">Add it properly (recommended)</option>
                      <option value="stage">Stage variable only (deploy time)</option>
                      <option value="buildArg" disabled={!canBuildArg}>
                        {canBuildArg
                          ? 'Build argument (baked into image)'
                          : 'Build argument — none on this stage'}
                      </option>
                      <option value="scriptExport" disabled={!canScript}>
                        {canScript
                          ? 'Script export (export NAME=value)'
                          : 'Script export — no script on this stage'}
                      </option>
                      <option value="yamlPlaceholder" disabled={!canYaml}>
                        {canYaml
                          ? 'Deploy YAML substitution (into the pod)'
                          : 'Deploy YAML substitution — no such step on this stage'}
                      </option>
                    </select>
                  </label>

                  {/* Only worth asking when there is a real choice. One task is the common case and
                      the backend picks it on its own. */}
                  {/* Not offered across a selection: the pipelines have different task names, so
                      pinning one would be wrong for most of them. */}
                  {/* Not offered for 'auto': it deliberately writes EVERY Docker task, which is
                      the point -- narrowing it to one is how a stage ends up half-wired. */}
                  {!multi && d.target !== '' && d.target !== 'stage' && d.target !== 'auto' &&
                    tasks.length > 1 && (
                    <label className={styles.field}>
                      {index === 0 && <span>Task</span>}
                      <select
                        value={d.taskName}
                        onChange={(e) => patch(d.id, { taskName: e.target.value })}
                      >
                        <option value="">First one that accepts it</option>
                        {tasks.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {drafts.length > 1 && (
                    <button
                      type="button"
                      className={styles.removeRow}
                      title="Remove this row"
                      onClick={() => setDrafts((prev) => prev.filter((o) => o.id !== d.id))}
                    >
                      Remove
                    </button>
                  )}
                </div>

                {d.error && <p className={`${styles.hint} ${styles.warnHint}`}>{d.error}</p>}
                {!d.error && problem && problem !== 'blank' && (
                  <p className={`${styles.hint} ${styles.warnHint}`}>{problem}</p>
                )}
                {!problem && d.target !== '' && (
                  <p className={styles.hint}>{TARGET_HELP[d.target]}</p>
                )}
                {/* Context, not an objection. A name existing as a stage variable is the NORMAL
                    reason to add it as a build argument -- the argument consumes it as $(NAME). */}
                {!problem &&
                  d.target !== '' &&
                  namesAnywhere.has(d.name.trim().toLowerCase()) && (
                    <p className={styles.hint}>
                      Note: {d.name.trim()} already exists on this stage as a{' '}
                      {namesAnywhere.get(d.name.trim().toLowerCase())}. Adding it here as well is
                      normal where one holds the value and the other passes it on.
                    </p>
                  )}
              </div>
            )
          })}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.create}
              disabled={!ready || create.isPending}
              onClick={() => void submit()}
            >
              {create.isPending
                ? 'Creating…'
                : submittable.length > 1
                  ? `Create ${submittable.length} variables`
                  : 'Create variable'}
            </button>
            <button
              type="button"
              className={styles.addRow}
              onClick={() => setDrafts((prev) => [...prev, blankDraft()])}
            >
              Add another
            </button>
            {drafts.some((d) => d.name || d.value || d.target) && (
              <button
                type="button"
                className={styles.cancel}
                onClick={() => {
                  setDrafts([blankDraft()])
                  setResult(null)
                }}
              >
                Clear all
              </button>
            )}
          </div>

          {result && result.text && (
            <div className={result.ok ? styles.okBox : styles.errBox}>{result.text}</div>
          )}
        </div>
      )}
    </section>
  )
}
