import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useEnvVarsQueries,
  useEnvVarsUpdateMutation,
  useIdentityQuery,
  usePortalMetaQuery,
} from '../api/hooks'
import type { EnvVarChange, EnvVarEntry } from '../api/types'
import { AddVariablePanel } from '../components/AddVariablePanel'
import { BulkVariableUpdate } from '../components/BulkVariableUpdate'
import { GitConfigPanel, isGitConfigPipeline } from '../components/GitConfigPanel'
import { isVariablesOpen } from '../utils/variablesAccess'
import pageStyles from './Page.module.css'
import styles from './VariablesPage.module.css'

/** Admins get every environment. Viewers are held to the lower three -- and that is enforced by
 * the backend refusing BETA and PROD for a viewer, not by this list; the list only mirrors it so
 * nobody is offered an option that would come back 403. */
const ENVS = ['DEV', 'SIT', 'UAT', 'BETA', 'PROD'] as const
const VIEWER_ENVS = ['DEV', 'SIT', 'UAT'] as const

/** Re-read the stage on screen every 20s. Only the pipeline+environment currently displayed is
 * polled -- that pair is the query key, so nothing else is being fetched in the background. */
const REFRESH_MS = 20_000

/** An entry plus the pipeline it came from -- needed once the screen can show several at once. */
type Row = EnvVarEntry & { pipeline: string }

/** Colour tone for a value cell.
 *
 * Green for ordinary settings, red for credentials -- so a screenful of configuration tells you at
 * a glance which lines matter if someone is looking over your shoulder. Withheld values get neither:
 * they are not a value at all, so colouring them like one would be a lie.
 *
 * Both tones come from the theme's status tokens, which are redefined for dark mode -- hard-coded
 * hex here would be unreadable on one theme or the other.
 */
function valueTone(entry: EnvVarEntry, styles: Record<string, string>): string {
  if (entry.value === null) return styles.withheld
  return entry.isSecret ? styles.valSecret : styles.valPlain
}

/** Stable key for a SOURCE, for filtering. Kept separate from describeSource() because that one
 * returns display text that includes the task name -- useless to group by, since a stage can have
 * several Docker tasks and you almost always want all of them at once. */
function sourceCategory(source: string): string {
  const s = source.toLowerCase()
  if (s.startsWith('stage variable')) return 'stage'
  if (s.startsWith('definition variable')) return 'definition'
  if (s.startsWith('build argument')) return 'buildArg'
  if (s.startsWith('script export')) return 'scriptExport'
  if (s.startsWith('variable group')) return 'group'
  return 'other'
}

/** Order matches how often they are wanted, not the order the backend emits them. */
const SOURCE_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All sources' },
  // Label is replaced with the actual environment at render time -- see sourceFilterLabel().
  { key: 'stage', label: 'This environment' },
  { key: 'definition', label: 'Pipeline-wide' },
  { key: 'buildArg', label: 'Built into image' },
  { key: 'scriptExport', label: 'Set in script' },
  { key: 'group', label: 'Shared list' },
  { key: 'other', label: 'Other' },
]

/** Label for a source filter option. The stage entry names the environment actually selected --
 * "SIT environment" rather than "This environment", which reads as a riddle when the value it
 * refers to is a dropdown two controls away. */
function sourceFilterLabel(key: string, env: string): string {
  if (key === 'stage') return `${env} environment`
  return SOURCE_FILTERS.find((f) => f.key === key)?.label ?? key
}

/** Plain-language name for a SOURCE, with Azure DevOps' own term kept underneath it.
 *
 * The technical term is deliberately NOT dropped. Someone cross-referencing this screen against
 * Azure DevOps has to find the same words in both places, and "definition variable" is what ADO
 * shows. It just stops being the thing you read first, because it means nothing to a reader who
 * does not already know the classic release model.
 *
 * The plain label also carries the CONSEQUENCE where there is one -- "Built into image" is the
 * fact people actually need, because it is the one that means a redeploy will not help.
 */
function describeSource(source: string, env: string): { label: string; term: string } {
  const s = source.toLowerCase()
  // Both build arguments and script exports are suffixed with the task they live on.
  const task = /\(([^)]+)\)\s*$/.exec(source)?.[1]
  if (s.startsWith('definition variable')) return { label: 'Pipeline-wide', term: source }
  if (s.startsWith('stage variable')) return { label: `${env} environment`, term: source }
  if (s.startsWith('variable group')) return { label: 'Shared list — read-only', term: source }
  if (s.startsWith('build argument'))
    return { label: task ? `Built into image (${task})` : 'Built into image', term: source }
  if (s.startsWith('script export'))
    return { label: task ? `Set in script (${task})` : 'Set in script', term: source }
  // Unknown source: show it as-is rather than inventing a friendly name for something we do not
  // recognise, which would hide the fact that a new kind has appeared.
  return { label: source, term: '' }
}

/** Pipeline variables across every pipeline and environment in both ADO projects (ECom and Macula).
 *
 * TWO SCREENS, ONE COMPONENT. An admin can edit, add and bulk-rotate. A viewer gets a strictly
 * read-only table: no add panel, no bulk tab, no save bar, and no BETA or PROD credential values --
 * the backend drops those from the payload rather than masking them, so they never reach the
 * browser at all. None of that gating lives here; this file only decides what to draw.
 *
 * Three deliberate constraints, each of which exists because of something real in this estate:
 *
 * 1. **Editing and adding are separate paths.** The table edits what already exists; AddVariablePanel
 *    creates what does not, several at a time. Creating forces an explicit choice between the three
 *    places a stage can hold configuration -- stage variable, Docker build argument, or an
 *    `export NAME=value` line in an inline script -- because putting a value in the wrong one is
 *    completely silent: nothing errors, the variable simply never takes effect.
 * 2. **No whole credential ever reaches the browser.** The definitions carry live secrets in
 *    plaintext build arguments. Secret values are masked SERVER-SIDE to first three characters,
 *    asterisks, last three -- enough to recognise a value and confirm a rotation changed it, and
 *    not enough to use. Masking in the UI instead would have left the full credential sitting in
 *    the JSON behind the page. BETA and PROD are not served by this screen at all: the endpoint
 *    refuses those environments outright rather than relying on the picker to hide them.
 * 3. **Save is a whole-definition write.** Classic release definitions have no per-variable update,
 *    so the revision read at load time is sent back with the save and ADO rejects it if anyone
 *    edited the definition meanwhile. That is why a stale tab reports a conflict rather than
 *    quietly overwriting someone.
 */
export function VariablesPage() {
  const meta = usePortalMetaQuery()
  // Presentation only. Every write route is @require_role("admin") server-side, and the backend
  // also returns editable=false and drops BETA/PROD credential values for a viewer.
  const { data: identity } = useIdentityQuery()
  const isAdmin = identity?.role === 'admin'
  // A LIST, so one screen can answer "what does this variable look like across these pipelines".
  // selected[0] stays the primary for everything that is inherently single-pipeline (the stage
  // name, the git-backed warning). Editing is NOT one of those: rows from every selected pipeline
  // can be edited, and each pipeline is written back as its own request. See `pendingByPipeline`.
  const [selected, setSelected] = useState<string[]>([])
  const [sort, setSort] = useState<{ col: 'name' | 'source' | null; dir: 'asc' | 'desc' }>({
    col: null,
    dir: 'asc',
  })
  const [hideDisabled, setHideDisabled] = useState(false)
  const [env, setEnv] = useState<string>('SIT')
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [showSecrets, setShowSecrets] = useState(true)
  // name+source -> new value. Only what the user actually touched is ever sent.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)
  // Own flag rather than save.isPending: a multi-pipeline save is several sequential mutations, and
  // save.isPending drops back to false between them, which would flicker the button mid-run.
  const [saving, setSaving] = useState(false)
  // Browse/edit is the landing view: looking up what a pipeline currently holds is the common
  // errand, and the bulk rotation is the deliberate one you go looking for.
  const [mode, setMode] = useState<'bulk' | 'single' | 'settings'>('single')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  // Whether the pipeline on screen keeps its settings in a repository rather than in the release
  // definition. Only meaningful for ONE pipeline: the settings-file view is a join across that
  // pipeline's own deployment files, and there is no sensible way to show two at once.
  const gitBacked = selected.length === 1 && isGitConfigPipeline(selected[0])

  // For a Git-backed pipeline the settings file IS the subject -- the release definition holds
  // almost nothing. So that tab leads, and selecting such a pipeline lands on it.
  //
  // Keyed on the pipeline CHANGING, not on gitBacked being true, so that clicking away to
  // "Browse / edit" is not immediately undone on the next render.
  const lastPipeline = useRef<string | null>(null)
  useEffect(() => {
    const current = selected.length === 1 ? selected[0] : null
    if (current === lastPipeline.current) return
    lastPipeline.current = current
    if (current && isGitConfigPipeline(current)) setMode('settings')
    else if (mode === 'settings') setMode('single')
    // `mode` is deliberately absent: this runs on a pipeline change, not on a tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  // Auto-refresh is SUSPENDED while there are unsaved edits, and not only to protect typing (typed
  // values live in `edits` and would survive a refetch anyway). The real reason is the revision:
  // onSave sends data.revision, and ADO rejects the write if the definition moved underneath. If
  // polling quietly refreshed that revision, a concurrent edit by someone else would stop being
  // detected and we would silently overwrite them -- turning the safety net into a hazard. Each
  // pipeline carries its OWN revision now (see pendingByPipeline), so this protects all of them.
  const multi = selected.length > 1
  // Stable identity for "which pipelines are on screen", so an effect can depend on the selection
  // itself rather than on the array reference, which changes on every render.
  const selectionKey = selected.join('\u0000')
  const hasUnsaved = Object.keys(edits).length > 0
  const results = useEnvVarsQueries(selected, selected.length ? env : null, hasUnsaved ? 0 : REFRESH_MS)
  // The primary pipeline's response drives what is inherently single-pipeline: the stage name, the
  // add panel's target list, the git-backed warning. Save revisions are per pipeline, not from here.
  const data = results[0]?.data
  const isLoading = results.some((r) => r.isLoading)
  const isFetching = results.some((r) => r.isFetching)
  const failed = results.filter((r) => r.isError)
  const isError = failed.length > 0 && failed.length === results.length
  const error = failed[0]?.error
  const dataUpdatedAt = Math.max(0, ...results.map((r) => r.dataUpdatedAt || 0))
  const refetch = () => results.forEach((r) => void r.refetch())
  const save = useEnvVarsUpdateMutation()

  // NOT meta.pipelines: that list comes from ADO deployment rows and includes definition names
  // the registry cannot resolve, so selecting one answered "unknown pipeline" with no way back.
  const pipelines = meta.data?.variablePipelines ?? []
  useEffect(() => {
    if (!selected.length && pipelines.length) setSelected([pipelines[0]])
  }, [pipelines, selected])

  // Viewers get the lower environments only -- except on the pipelines the backend lists as open
  // (Rivoli, Rivoli Sanity), which every role may read on every environment. With several
  // pipelines on screen, BETA/PROD are offered only if ALL of them are open, since the endpoint
  // would refuse the others.
  const openAliases = meta.data?.variablesOpenAliases
  const allOpen = selected.length > 0 && selected.every((p) => isVariablesOpen(openAliases, p))
  const envOptions: readonly string[] = isAdmin || allOpen ? ENVS : VIEWER_ENVS
  useEffect(() => {
    // Switching a viewer from an open pipeline to a restricted one while on BETA/PROD would leave
    // the screen asking for a stage it is not allowed to read.
    if (!envOptions.includes(env)) setEnv('SIT')
  }, [envOptions, env])

  // Any change of target abandons pending edits -- carrying them across would apply values typed
  // for one environment to a different one.
  useEffect(() => {
    setEdits({})
    setResult(null)
    setConfirming(false)
    // Keyed on the whole selection, not just the primary: edits are held per pipeline now, so
    // swapping the second pipeline out while one of its rows is edited would otherwise leave a
    // pending change aimed at a definition no longer on screen.
  }, [selectionKey, env])

  // Pipeline is part of the key so rows from different pipelines cannot collide in React's list
  // reconciliation, or in `edits` if the selection changes under a pending edit.
  const key = (e: Row) => `${e.pipeline}|${e.name} ${e.source}`

  // Every selected pipeline's entries, each tagged with where it came from.
  const allRows: Row[] = useMemo(
    () =>
      results.flatMap((r, i) =>
        (r.data?.entries ?? []).map((e) => ({ ...e, pipeline: selected[i] ?? '' })),
      ),
    [results, selected],
  )

  // Everything the name/secret filters allow, BEFORE the source filter. The dropdown counts come
  // from here, so each option says how many rows picking it would actually give you.
  const matched = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows.filter((e) => {
      if (!showSecrets && e.isSecret) return false
      if (hideDisabled && e.taskEnabled === false) return false
      if (!needle) return true
      return (
        e.name.toLowerCase().includes(needle) ||
        e.source.toLowerCase().includes(needle) ||
        e.pipeline.toLowerCase().includes(needle)
      )
    })
  }, [allRows, search, showSecrets, hideDisabled])

  // Counted before hideDisabled is applied, so the toggle can say what it would remove.
  const disabledCount = useMemo(
    () => allRows.filter((e) => e.taskEnabled === false).length,
    [allRows],
  )

  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = { all: matched.length }
    for (const e of matched) {
      const c = sourceCategory(e.source)
      counts[c] = (counts[c] ?? 0) + 1
    }
    return counts
  }, [matched])

  const filtered = useMemo(
    () =>
      sourceFilter === 'all'
        ? matched
        : matched.filter((e) => sourceCategory(e.source) === sourceFilter),
    [matched, sourceFilter],
  )

  /** Sorting by SOURCE puts LIVE rows first and disabled ones last, then groups by kind, then task.
   * That ordering is the point of the control: on a stage with three Docker tasks, the thing you
   * almost always want is "show me the one that actually runs". */
  const rows = useMemo(() => {
    if (!sort.col) return filtered
    const dir = sort.dir === 'asc' ? 1 : -1
    const keyOf = (e: Row) =>
      sort.col === 'name'
        ? `${e.name.toLowerCase()}|${e.source}`
        : [
            e.taskEnabled === false ? '1' : '0',
            String(
              SOURCE_FILTERS.findIndex((f) => f.key === sourceCategory(e.source)),
            ).padStart(2, '0'),
            e.source.toLowerCase(),
            e.name.toLowerCase(),
          ].join('|')
    return [...filtered].sort((a, b) => keyOf(a).localeCompare(keyOf(b)) * dir)
  }, [filtered, sort])

  function toggleSort(col: 'name' | 'source') {
    setSort((prev) =>
      prev.col !== col
        ? { col, dir: 'asc' }
        : prev.dir === 'asc'
          ? { col, dir: 'desc' }
          : { col: null, dir: 'asc' },
    )
  }
  const sortMark = (col: 'name' | 'source') =>
    sort.col !== col ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼'

  // Union across the selection: a target is offered if ANY selected pipeline can take it. A
  // pipeline that cannot is reported by the backend rather than blocking the others.
  const allBuildArgTasks = useMemo(
    () => [...new Set(results.flatMap((r) => r.data?.buildArgTasks ?? []))],
    [results],
  )
  const allYamlTasks = useMemo(
    () => [...new Set(results.flatMap((r) => r.data?.yamlTasks ?? []))],
    [results],
  )
  const allScriptTasks = useMemo(
    () => [...new Set(results.flatMap((r) => r.data?.scriptTasks ?? []))],
    [results],
  )

  /** Pending edits grouped by the pipeline each one belongs to.
   *
   * A save is a whole-definition PUT carrying THAT definition's revision (see constraint 3 above),
   * so two pipelines cannot travel in one request. They can travel in one click, as one request
   * each. Comparing two stages side by side and fixing the same wrong value in both is the whole
   * point of the comparison view; previously its rows were editable while the save bar was hidden,
   * so the typed changes had nowhere to go.
   */
  const pendingByPipeline = useMemo(() => {
    return selected
      .map((p, i) => {
        const d = results[i]?.data
        const rowsFor = allRows.filter((e) => e.pipeline === p)
        const changes = Object.entries(edits)
          .map(([k, value]) => {
            const entry = rowsFor.find((e) => key(e) === k)
            return entry ? { name: entry.name, value, source: entry.source } : null
          })
          .filter(Boolean) as EnvVarChange[]
        return {
          pipeline: p,
          revision: d?.revision,
          stageName: d?.stageName,
          definitionName: d?.definitionName,
          project: d?.project,
          changes,
        }
      })
      .filter((g) => g.changes.length > 0)
  }, [edits, allRows, selected, results])

  const pendingCount = pendingByPipeline.reduce((n, g) => n + g.changes.length, 0)

  /** One request per pipeline, in sequence.
   *
   * Sequential rather than concurrent on purpose: each call is a whole-definition PUT against ADO,
   * and a per-pipeline result is only readable if the failures can be attributed. Edits are cleared
   * ONLY for the pipelines that actually wrote -- clearing everything after a partial failure would
   * throw away values the user still has to retry.
   */
  async function onSave() {
    if (!pendingByPipeline.length) return
    setResult(null)
    setSaving(true)
    const written = new Set<string>()
    const lines: string[] = []
    let allOk = true
    for (const g of pendingByPipeline) {
      if (g.revision === undefined) {
        allOk = false
        lines.push(`${g.pipeline}: not loaded yet — nothing written`)
        continue
      }
      try {
        const r = await save.mutateAsync({
          pipeline: g.pipeline,
          env,
          changes: g.changes,
          revision: g.revision,
        })
        if (r.ok) written.add(g.pipeline)
        else allOk = false
        lines.push(`${g.pipeline}: ${r.message}`)
      } catch (err) {
        allOk = false
        lines.push(`${g.pipeline}: ${(err as Error).message}`)
      }
    }
    setSaving(false)
    setConfirming(false)
    // key() is `${pipeline}|${name} ${source}` and no pipeline name contains a pipe.
    setEdits((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([k]) => !written.has(k.split('|')[0]))),
    )
    setResult({ ok: allOk, text: lines.join(' · ') })
  }

  return (
    <main className={pageStyles.main}>
      <h1 className={styles.title}>
        Pipeline variables{!isAdmin && <span className={styles.roPill}>Read only</span>}
      </h1>
      <p className={styles.lede}>
        {isAdmin ? (
          <>
            Edit variables on any release definition in ECom or Macula. Changes apply to{' '}
            <strong>new releases</strong> — releases that already exist keep the values they were
            created with.
          </>
        ) : (
          <>
            Every variable configured on any release definition in ECom or Macula — stage variables,
            Docker build arguments and script exports. Nothing on this page can be changed.
            Covers <strong>DEV, SIT and UAT</strong>. Credential values are partly masked — first
            and last three characters only.
          </>
        )}
      </p>

      {/* The bulk tab is a WRITE tool, so a viewer is not offered the choice at all. The settings
          tab is a READ, and it is the only useful view of a Git-backed pipeline, so viewers do get
          that one -- the backend holds them to the lower environments and masks values. */}
      {(isAdmin || gitBacked) && (
        <div className={styles.modeTabs}>
          {/* First, and named for what it is rather than for the Kubernetes object behind it. */}
          {gitBacked && (
            <button
              className={`${styles.modeTab} ${mode === 'settings' ? styles.modeTabActive : ''}`}
              onClick={() => setMode('settings')}
            >
              Settings file
            </button>
          )}
          {/* For a Git-backed pipeline the other two tabs are noise and actively misleading: the
              release definition holds seven infrastructure values, none of which are the app's
              settings, and offering "edit variables" next to them invites changing the wrong thing.
              Pick another pipeline and they come back. */}
          {isAdmin && !gitBacked && (
            <>
              <button
                className={`${styles.modeTab} ${mode === 'single' ? styles.modeTabActive : ''}`}
                onClick={() => setMode('single')}
              >
                Browse / edit one pipeline
              </button>
              <button
                className={`${styles.modeTab} ${mode === 'bulk' ? styles.modeTabActive : ''}`}
                onClick={() => setMode('bulk')}
              >
                Update one variable across pipelines
              </button>
            </>
          )}
        </div>
      )}

      {/* The settings view needs its own pipeline and environment pickers: the big filter bar below
          belongs to the browse/edit table and is not rendered in this mode, which had the effect of
          removing the environment switch entirely once a Git-backed pipeline was selected. */}
      {mode === 'settings' && gitBacked && (
        <>
          <div className={styles.filters}>
            <label className={styles.field}>
              <span>Pipeline</span>
              <select
                value={selected[0] ?? ''}
                onChange={(ev) => setSelected([ev.target.value])}
              >
                {pipelines.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Environment</span>
              <select value={env} onChange={(ev) => setEnv(ev.target.value)}>
                {envOptions.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <GitConfigPanel pipeline={selected[0]} env={env} />
        </>
      )}

      {isAdmin && mode === 'bulk' && <BulkVariableUpdate />}

      {mode === 'single' && (
      <>
      <div className={styles.filters}>
        <div className={styles.field}>
          <span>Pipeline{multi ? `s (${selected.length})` : ''}</span>
          <div className={styles.pipeStack}>
            {selected.map((p, i) => (
              <div key={`${p}-${i}`} className={styles.pipeRow}>
                <select
                  value={p}
                  onChange={(ev) =>
                    setSelected((cur) => cur.map((x, j) => (j === i ? ev.target.value : x)))
                  }
                >
                  {pipelines.map((opt) => (
                    <option
                      key={opt}
                      value={opt}
                      // Already on screen elsewhere -- picking it twice would just duplicate rows.
                      disabled={opt !== p && selected.includes(opt)}
                    >
                      {opt}
                    </option>
                  ))}
                </select>
                {selected.length > 1 && (
                  <button
                    type="button"
                    className={styles.pipeRemove}
                    title="Remove this pipeline"
                    onClick={() => setSelected((cur) => cur.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {selected.length < pipelines.length && (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() =>
                  setSelected((cur) => [...cur, pipelines.find((x) => !cur.includes(x)) as string])
                }
              >
                + Compare another pipeline
              </button>
            )}
          </div>
        </div>
        <label className={styles.field}>
          <span>Environment</span>
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            {envOptions.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Filter</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="name or source…" />
        </label>
        <label className={styles.field}>
          <span>Source</span>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            {SOURCE_FILTERS.map((f) => (
              // Options that would return nothing are kept but disabled, so the shape of the stage
              // stays visible -- "Set in script (0)" tells you this stage has no script, which is
              // itself worth knowing.
              <option key={f.key} value={f.key} disabled={(sourceCounts[f.key] ?? 0) === 0}>
                {sourceFilterLabel(f.key, env)} ({sourceCounts[f.key] ?? 0})
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={showSecrets} onChange={(e) => setShowSecrets(e.target.checked)} />
          Show secrets
        </label>
        {/* Only offered when the stage actually has both kinds -- a toggle that would change
            nothing is just another control to read past. */}
        {disabledCount > 0 && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={hideDisabled}
              onChange={(e) => setHideDisabled(e.target.checked)}
            />
            Hide disabled ({disabledCount})
          </label>
        )}
      </div>

      {isLoading && <p className={pageStyles.loading}>Loading…</p>}
      {isError && <p className={pageStyles.error}>{(error as Error).message}</p>}

      {data && (
        <>
          <div className={styles.metaRow}>
            <p className={styles.meta}>
              {multi ? (
                <>
                  {selected.length} pipelines · stage “{env}” · {allRows.length} variables,{' '}
                  {allRows.filter((r) => r.isSecret).length} masked ·{' '}
                  <strong>comparison view — each pipeline is saved separately</strong>
                </>
              ) : (
                <>
                  {data.definitionName} → stage “{data.stageName}” · {data.project} · revision{' '}
                  {data.revision} · {data.entries.length} variables, {data.secretCount} masked
                </>
              )}
            </p>
            <div className={styles.refreshBar}>
              {hasUnsaved ? (
                <span className={styles.paused}>
                  Auto-refresh paused — unsaved changes
                </span>
              ) : (
                <span className={styles.readAt}>
                  {dataUpdatedAt
                    ? `Last read ${new Date(dataUpdatedAt).toLocaleTimeString()}`
                    : 'Not read yet'}
                  {isFetching && ' · refreshing…'}
                </span>
              )}
              <button
                type="button"
                className={styles.refreshBtn}
                onClick={() => void refetch()}
                disabled={isFetching}
                title="Re-read this stage from Azure DevOps now"
              >
                {isFetching ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>

          {!multi && data.liveValueSource?.warning && (
            <div className={styles.warn}>
              <strong>This stage does not read its running values from here.</strong>{' '}
              {data.liveValueSource.message}
            </div>
          )}

          {result && (
            <div className={result.ok ? styles.okBox : styles.errBox}>{result.text}</div>
          )}

          {/* Above the table, not below it: adding is what you came for when the thing you searched
              is not there, and that is exactly the moment the table is empty. */}
          {/* Creating works across a selection -- the endpoint takes a list and reports per
              pipeline. Editing spans the selection too, but as one request per pipeline: a save
              carries one definition's revision, so they cannot share a request. */}
          {isAdmin && (
          <AddVariablePanel
            pipelines={selected}
            env={env}
            stageName={multi ? undefined : data.stageName}
            buildArgTasks={allBuildArgTasks}
            scriptTasks={allScriptTasks}
            yamlTasks={allYamlTasks}
            entries={data.entries}
          />
          )}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {multi && <th>Pipeline</th>}
                  <th>
                    <button type="button" className={styles.sortBtn} onClick={() => toggleSort('name')}>
                      Name{sortMark('name')}
                    </button>
                  </th>
                  <th>Value</th>
                  <th>
                    <button type="button" className={styles.sortBtn} onClick={() => toggleSort('source')}>
                      Source{sortMark('source')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const k = key(e)
                  const edited = k in edits
                  return (
                    <tr
                      key={k}
                      className={[
                        edited ? styles.editedRow : '',
                        e.taskEnabled === false ? styles.offRow : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {multi && <td className={styles.pipeCell}>{e.pipeline}</td>}
                      <td className={styles.name}>{e.name}</td>
                      <td>
                        {e.editable ? (
                          <input
                            className={`${styles.input} ${valueTone(e, styles)} ${edited ? styles.inputEdited : ''}`}
                            value={edited ? edits[k] : e.value ?? ''}
                            placeholder={e.isSecret ? 'masked — type to replace' : ''}
                            onChange={(ev) =>
                              setEdits((prev) => ({ ...prev, [k]: ev.target.value }))
                            }
                          />
                        ) : (
                          // value === null is the backend REFUSING to send it (a credential this
                          // caller may not have). That is different from an empty string, and the
                          // two must not render the same -- "(empty)" on a withheld secret would
                          // read as "this variable has no value set".
                          <span
                            className={`${styles.readonly} ${valueTone(e, styles)}`}
                          >
                            {e.value === null
                              ? 'withheld'
                              : e.value === ''
                                ? '(empty)'
                                : e.value}
                            {isAdmin && ' — read-only here'}
                          </span>
                        )}
                        {edited && (
                          <button
                            className={styles.undo}
                            onClick={() =>
                              setEdits((prev) => {
                                const next = { ...prev }
                                delete next[k]
                                return next
                              })
                            }
                          >
                            undo
                          </button>
                        )}
                      </td>
                      <td className={styles.source}>
                        <span className={styles.sourceLabel}>{describeSource(e.source, env).label}</span>
                        {describeSource(e.source, env).term && (
                          <span className={styles.sourceTerm}>{describeSource(e.source, env).term}</span>
                        )}
                        {e.taskEnabled === false && (
                          <span className={styles.offTag}>task disabled — not used</span>
                        )}
                        {/* A push task stores buildArguments but Azure DevOps never reads them --
                            it does not even show the field. Left visible rather than hidden,
                            because these stale lines exist across the estate and pretending they
                            are not there is how someone edits one expecting an effect. */}
                        {e.buildsImage === false && (
                          <span className={styles.offTag}>push task — build arguments ignored here</span>
                        )}
                        {/* Stage-variable rows only (the backend sets `wired` on nothing else). A
                            stage variable that nothing references is saved, correct-looking and
                            completely inert -- Ecom Paymob carried both Sentry DSNs this way while
                            Sentry received nothing. Worth calling out on the row itself, because
                            there is no other way to see it. */}
                        {e.wired === true && (
                          <span className={styles.wiredTag} title={(e.wiredBy ?? []).join(', ')}>
                            used by {(e.wiredBy ?? []).join(', ')}
                          </span>
                        )}
                        {e.wired === false && (
                          <span className={styles.unwiredTag}>
                            nothing uses this — value never reaches the app
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={multi ? 4 : 3} className={styles.empty}>
                      {/* Deliberately NOT auto-resetting the source filter: someone comparing the
                          same source across pipelines wants it to stick. Explain instead, and make
                          clearing it one click. */}
                      {sourceFilter !== 'all' && matched.length > 0 ? (
                        <>
                          This stage has nothing under{' '}
                          <strong>
                            {sourceFilterLabel(sourceFilter, env)}
                          </strong>
                          . {matched.length} variable{matched.length === 1 ? '' : 's'} match your
                          other filters.{' '}
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() => setSourceFilter('all')}
                          >
                            Show all sources
                          </button>
                        </>
                      ) : (
                        'Nothing matches that filter.'
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {isAdmin && (
          <div className={styles.saveBar}>
            <span className={styles.pendingCount}>
              {pendingCount === 0
                ? 'No changes'
                : `${pendingCount} change${pendingCount === 1 ? '' : 's'} ready` +
                  (pendingByPipeline.length > 1
                    ? ` across ${pendingByPipeline.length} pipelines`
                    : '')}
            </span>
            <button
              className={styles.saveButton}
              disabled={!pendingCount || saving}
              onClick={() => setConfirming(true)}
            >
              {saving ? 'Saving…' : 'Review and save'}
            </button>
          </div>
          )}
        </>
      )}

      </>
      )}

      {/* Explicit confirm listing every variable by name. A whole-definition PUT is not something
          to fire off a single click, and the list is the last chance to spot a wrong target. */}
      {confirming && pendingByPipeline.length > 0 && (
        <div className={styles.backdrop} onClick={() => setConfirming(false)} role="presentation">
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.dialogTitle}>Write these to Azure DevOps?</h2>
            {/* Grouped by pipeline, each with its own definition and revision, because that is
                exactly how they are sent: one whole-definition PUT per pipeline. */}
            {pendingByPipeline.map((g) => (
              <div key={g.pipeline}>
                <p className={styles.dialogMeta}>
                  {g.definitionName ?? g.pipeline} → <strong>{g.stageName ?? env}</strong>
                  {g.project ? ` (${g.project})` : ''}, revision {g.revision}
                </p>
                <ul className={styles.changeList}>
                  {g.changes.map((c) => (
                    <li key={`${g.pipeline}-${c.name}-${c.source}`}>
                      <code>{c.name}</code> <span className={styles.source}>· {c.source}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className={styles.dialogNote}>
              Values are not shown here on purpose. This takes effect for releases created from now
              on; existing releases are unaffected.
              {pendingByPipeline.length > 1 && (
                <>
                  {' '}
                  Each pipeline is written separately, so one can succeed while another is rejected —
                  the result line says which.
                </>
              )}
            </p>
            <div className={styles.dialogActions}>
              <button className={styles.cancel} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className={styles.confirm} onClick={() => void onSave()} disabled={saving}>
                {saving ? 'Writing…' : `Write ${pendingCount} change${pendingCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
