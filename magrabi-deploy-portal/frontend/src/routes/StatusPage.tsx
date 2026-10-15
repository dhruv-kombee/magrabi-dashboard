import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLiveStatusQuery } from '../api/hooks'
import {
  ALL_ENVS,
  LiveStatusControls,
  REFRESH_STORAGE_KEY,
  readStoredRefreshMs,
  type EnvFilter,
  type StatusView,
} from '../components/LiveStatusControls'
import { EnvSection, type LiveStatusRowFull } from '../components/EnvSection'
import { EnvTiles } from '../components/EnvTiles'
import pageStyles from './Page.module.css'

/** Free-text search spans every identifier someone would actually have in hand -- an application
 * or pipeline name from a ticket, a branch from a PR, a release or build number read off an ADO
 * tab. Deliberately not the environment: that has its own filter buttons, and folding it in here
 * would make typing "prod" empty out three of the four sections rather than filtering within them. */
function matchesSearch(row: LiveStatusRowFull, needle: string): boolean {
  const haystack = [row.application, row.pipeline, row.release, row.branch, row.buildNumber, row.commitId]
  return haystack.some((value) => (value ?? '').toLowerCase().includes(needle))
}

/** The environment filter lives in the URL so a link can point at one environment.
 *
 * This page is shared into Teams as the "has it reached PROD yet" board, and without the filter in
 * the address every recipient opened it on ALL and had to click PROD themselves -- so the link did
 * not say what the sender meant it to say. `?env=PROD` now does.
 *
 * Unknown or absent values fall back to ALL rather than erroring: these links get retyped and
 * forwarded by hand, and a typo should show more than intended, never a broken page.
 */
function envFromParam(raw: string | null): EnvFilter {
  const wanted = (raw ?? '').trim().toUpperCase()
  if (!wanted) return 'ALL'
  if (wanted === 'ALL') return 'ALL'
  return (ALL_ENVS as readonly string[]).includes(wanted) ? (wanted as EnvFilter) : 'ALL'
}

/** Tiles are the default view: "what is each service running in this environment right now" is the
 * question this page is opened for, and a card per service answers it without reading across seven
 * columns. The table stays one click away and keeps its own URL (`?view=table`), because it is what
 * gets shared as the promotion board and what sorting is for. */
const DEFAULT_VIEW: StatusView = 'tiles'
const VIEW_STORAGE_KEY = 'status-view'

function viewFromParam(raw: string | null): StatusView | null {
  const wanted = (raw ?? '').trim().toLowerCase()
  if (wanted === 'tiles' || wanted === 'table') return wanted
  return null
}

/** The remembered choice, for visits that did not arrive through a link. A link's `?view=` always
 * wins over this -- otherwise someone who prefers the table would open a shared tile link and not
 * see what the sender saw. */
function readStoredView(): StatusView {
  try {
    return viewFromParam(localStorage.getItem(VIEW_STORAGE_KEY)) ?? DEFAULT_VIEW
  } catch {
    return DEFAULT_VIEW
  }
}

export function StatusPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [refreshMs, setRefreshMs] = useState<number>(readStoredRefreshMs)
  // The chosen cadence drives both arguments. `enabled` is belt-and-braces on top of a 0 interval:
  // it also suppresses the refetch-on-mount/reconnect that would otherwise fire while the user has
  // asked for "Off". A disabled query still serves whatever it already has cached, so the table
  // stays on screen -- it just stops changing under you.
  const { data, isLoading, isError, error, isFetching, refetch } = useLiveStatusQuery(
    refreshMs > 0,
    refreshMs,
  )
  // Both filters are read straight off the URL rather than mirrored into state, so a pasted link,
  // a bookmark and the Back button all agree with what is on screen without a syncing effect.
  const search = searchParams.get('q') ?? ''
  const bootstrapped = useRef(false)
  const view = viewFromParam(searchParams.get('view')) ?? readStoredView()
  // Tiles render one environment at a time, so ALL has no meaning there. Resolved at read time
  // rather than by rewriting the URL, so switching to the table brings ALL back rather than
  // leaving the user stranded on DEV.
  const envParam = envFromParam(searchParams.get('env'))
  const activeEnv: EnvFilter = view === 'tiles' && envParam === 'ALL' ? 'DEV' : envParam

  function updateParams(next: { env?: EnvFilter; q?: string; view?: StatusView }) {
    const params = new URLSearchParams(searchParams)
    if (next.env !== undefined) {
      // ALL is the default, so it stays out of the address -- a bare /status link is the "everything"
      // view and should look like one.
      if (next.env === 'ALL') params.delete('env')
      else params.set('env', next.env)
    }
    if (next.q !== undefined) {
      if (next.q.trim()) params.set('q', next.q)
      else params.delete('q')
    }
    if (next.view !== undefined) {
      params.set('view', next.view)
      // Pin the environment when leaving the table on ALL, so the tile grid does not silently
      // become "DEV" in a link that still says "everything".
      if (next.view === 'tiles' && envFromParam(params.get('env')) === 'ALL') params.set('env', 'DEV')
    }
    // replace, not push: typing in the search box must not fill the Back button with one entry
    // per keystroke.
    setSearchParams(params, { replace: true })
  }

  function changeView(next: StatusView) {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next)
    } catch {
      /* private mode / storage blocked -- the URL still carries the choice for this visit */
    }
    updateParams({ view: next })
  }

  useEffect(() => {
    localStorage.setItem(REFRESH_STORAGE_KEY, String(refreshMs))
  }, [refreshMs])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    // A disabled query never fires its own first fetch, so an "Off" preference restored from a
    // previous session would leave the page permanently empty. refetch() works on a disabled
    // query; the ref keeps this to the initial load and never re-arms when the setting changes.
    if (refreshMs === 0) void refetch()
  }, [refreshMs, refetch])

  const rows: LiveStatusRowFull[] = data?.rows ?? []

  const filteredByEnv = useMemo(() => {
    const envsToShow = activeEnv === 'ALL' ? ALL_ENVS : [activeEnv]
    const needle = search.trim().toLowerCase()
    return envsToShow.map((env) => {
      let envRows = rows.filter((r) => r.env === env)
      if (needle) envRows = envRows.filter((r) => matchesSearch(r, needle))
      return { env, rows: envRows }
    })
  }, [rows, activeEnv, search])

  const shownCount = filteredByEnv.reduce((sum, s) => sum + s.rows.length, 0)
  const totalPipelines = ALL_ENVS.length ? rows.length / ALL_ENVS.length : 0

  // `!data` covers the render between mount and the bootstrap refetch above landing: with
  // auto-refresh Off the query is disabled, so it reports neither loading nor error yet, and
  // without this the page would flash an empty table before the first rows arrive.
  if (isLoading || (!data && !isError))
    return <main className={pageStyles.main}><p className={pageStyles.loading}>Loading…</p></main>
  if (isError) return <main className={pageStyles.main}><p className={pageStyles.error}>{(error as Error).message}</p></main>

  return (
    <main className={pageStyles.main}>
      <LiveStatusControls
        search={search}
        onSearchChange={(value) => updateParams({ q: value })}
        activeEnv={activeEnv}
        onEnvChange={(env) => updateParams({ env })}
        shownCount={shownCount}
        totalPipelines={totalPipelines}
        refreshMs={refreshMs}
        onRefreshMsChange={setRefreshMs}
        updated={data?.updated}
        isFetching={isFetching}
        onRefreshNow={() => void refetch()}
        view={view}
        onViewChange={changeView}
      />
      {filteredByEnv.map(({ env, rows: envRows }) =>
        view === 'tiles' ? (
          <EnvTiles key={env} env={env} rows={envRows} />
        ) : (
          <EnvSection key={env} env={env} rows={envRows} />
        ),
      )}
    </main>
  )
}
