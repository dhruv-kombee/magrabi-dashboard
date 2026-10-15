import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { DeploymentFilters as DeploymentFiltersType, DeploymentRow } from '../api/types'
import { useDeploymentsQuery, useIdentityQuery } from '../api/hooks'
import { DeploymentCard } from '../components/DeploymentCard'
import { DeploymentDetailDrawer } from '../components/DeploymentDetailDrawer'
import { matchesTileLink } from '../components/CopyTileLink'
import { DeploymentFilters, EMPTY_FILTERS, FILTER_KEYS } from '../components/DeploymentFilters'
import { formatTimestamp } from '../utils/format'
import pageStyles from './Page.module.css'
import styles from './DeploymentsPage.module.css'
import { AdoUnreachableBanner } from '../components/AdoUnreachableBanner'

const SHOW_AUTO_REJECTED_STORAGE_KEY = 'deployments-show-auto-rejected'

// One fixed cadence, deliberately not configurable: this is a live wall-board and a two second poll
// is cheap enough on the bulk feed that letting anyone slow it down only makes the page lie.
const REFRESH_MS = 2_000

const PAGE_SIZE = 25

// Hidden by default, so the absent key means "hide" and only an explicit "true" opts in.
function readStoredShowAutoRejected(): boolean {
  try {
    return window.localStorage.getItem(SHOW_AUTO_REJECTED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Azure DevOps auto-rejects a pending pre-deploy approval on a ~1 minute timeout, and every new
 * release spawns one of these per environment nobody approved. They never started, no human caused
 * them, and they outnumber real deployments roughly two to one -- left in, the page is a wall of red
 * for non-events. A rejection a human actually made, and anything that ran and then failed, both
 * carry a startedOn and so are never matched here. */
function isAutoRejected(row: DeploymentRow): boolean {
  return row.status === 'rejected' && row.startedOn === null
}

// Anything a developer is waiting on sorts above anything already finished, and a stuck deployment
// jumps the whole in-flight group -- it is the single thing this page exists to surface.
const IN_FLIGHT_RANK: Record<string, number> = {
  inProgress: 1,
  building: 1,
  waiting: 2,
  queued: 2,
}

function groupRank(row: DeploymentRow): number {
  const rank = IN_FLIGHT_RANK[row.status]
  if (rank === undefined) return 5
  return row.isStuck ? 0 : rank
}

function toMillis(iso: string | null): number {
  if (!iso) return 0
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/** Recency of a deployment for sorting: when it started, falling back to when it was queued for
 * something that has not started yet, and to completion for the odd row missing a start time. */
function recencyMs(row: DeploymentRow): number {
  return toMillis(row.startedOn) || toMillis(row.queuedOn) || toMillis(row.completedOn)
}

function activityMs(row: DeploymentRow): number {
  return toMillis(row.completedOn) || toMillis(row.startedOn) || toMillis(row.queuedOn)
}

/** Page numbers to render: always the first, the last, and the current with a neighbour either
 * side, with a gap standing in for whatever was skipped. Capped at seven slots so a 40-page result
 * set produces the same width of control as a 9-page one. */
function pageWindow(current: number, total: number): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)

  const first = 1
  const last = total
  const start = Math.max(first + 1, current - 1)
  const end = Math.min(last - 1, current + 1)

  const items: Array<number | 'gap'> = [first]
  if (start > first + 1) items.push('gap')
  for (let page = start; page <= end; page += 1) items.push(page)
  if (end < last - 1) items.push('gap')
  items.push(last)
  return items
}

function EmptyState({
  hasFilters,
  hiddenAutoRejectedCount,
  onClear,
  onShowAutoRejected,
}: {
  hasFilters: boolean
  hiddenAutoRejectedCount: number
  onClear: () => void
  onShowAutoRejected: () => void
}) {
  // The one case where "nothing here" would be a lie: every row that came back was auto-rejected
  // and got hidden. Saying so, with the way out, matters more than the generic copy.
  const emptiedByHide = hiddenAutoRejectedCount > 0

  return (
    <div className={styles.empty}>
      <svg
        className={styles.emptyIcon}
        viewBox="0 0 48 48"
        width="48"
        height="48"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M7 17 L24 8 L41 17 L24 26 Z" />
        <path d="M7 24 L24 33 L41 24" />
        <path d="M7 31 L24 40 L41 31" />
      </svg>
      <p className={styles.emptyTitle}>No deployments to show</p>
      <p className={styles.emptyText}>
        {emptiedByHide
          ? `Everything that matched was an auto-rejected deployment that never started, so ${
              hiddenAutoRejectedCount === 1 ? 'it is' : 'all of them are'
            } hidden.`
          : hasFilters
            ? 'Nothing in the feed matches the current filters. Widen the date range or clear them to see everything.'
            : 'Azure DevOps has not reported any release deployments for this window yet.'}
      </p>
      {emptiedByHide && (
        <button type="button" className={styles.emptyButton} onClick={onShowAutoRejected}>
          Show auto-rejected deployments
        </button>
      )}
      {hasFilters && (
        <button type="button" className={styles.emptyButton} onClick={onClear}>
          Clear all filters
        </button>
      )}
    </div>
  )
}

export function DeploymentsPage() {
  const [filters, setFilters] = useState<DeploymentFiltersType>(EMPTY_FILTERS)
  const [showAutoRejected, setShowAutoRejected] = useState<boolean>(readStoredShowAutoRejected)
  const [selected, setSelected] = useState<DeploymentRow | null>(null)
  const [page, setPage] = useState(1)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  // A deep link is honoured exactly once. Without the latch the drawer would reopen on every poll,
  // making the page impossible to browse away from while the link is still in the address bar.
  const deepLinkHandled = useRef(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_AUTO_REJECTED_STORAGE_KEY, String(showAutoRejected))
    } catch {
      // Storage can be blocked (private mode, locked-down profile). Worst case the preference
      // resets on reload; nothing else depends on the write succeeding.
    }
  }, [showAutoRejected])

  // Hiding a tile is admin-only. The backend enforces it on both routes; this just decides whether
  // the button is drawn and whether asking for hidden rows is worth doing.
  const { data: identity } = useIdentityQuery()
  const isAdmin = identity?.role === 'admin'
  const [showHidden, setShowHidden] = useState(false)
  const revealHidden = isAdmin && showHidden

  const { data, isLoading, isError, error, isFetching } = useDeploymentsQuery(
    filters,
    REFRESH_MS,
    true,
    revealHidden,
  )

  const rows = useMemo(() => data?.rows ?? [], [data])
  // Counted server-side against the same filters, so it describes what this reader would otherwise
  // be seeing rather than the whole store.
  const hiddenCount = data?.hiddenCount ?? 0
  const hiddenTotal = data?.hiddenTotal ?? 0

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => groupRank(a) - groupRank(b) || recencyMs(b) - recencyMs(a)),
    [rows],
  )

  // Asking for Status: Rejected IS asking for these rows -- the status filter runs server-side, so
  // honouring the default hide on top of it would answer an explicit request with a blank screen.
  // An explicit filter therefore always beats the default.
  const autoRejectedForced = String(filters.status ?? '').trim().toLowerCase() === 'rejected'
  const hideAutoRejected = !showAutoRejected && !autoRejectedForced

  const visibleRows = useMemo(
    () => (hideAutoRejected ? sortedRows.filter((row) => !isAutoRejected(row)) : sortedRows),
    [sortedRows, hideAutoRejected],
  )

  const hiddenAutoRejectedCount = sortedRows.length - visibleRows.length

  // Derived from what is on screen, not from the raw feed, so the tiles can never describe rows the
  // reader cannot see. Numerically this is the same either way today -- an auto-rejected row is
  // never in progress, queued, failed, succeeded or stuck -- but keeping one source of truth means
  // it stays honest if the hide ever widens.
  const summary = useMemo(() => {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const todayMs = startOfToday.getTime()

    let running = 0
    let pending = 0
    let failedToday = 0
    let succeededToday = 0
    let stuck = 0

    for (const row of visibleRows) {
      if (row.status === 'inProgress' || row.status === 'building') running += 1
      else if (row.status === 'queued' || row.status === 'waiting') pending += 1
      if (row.isStuck) stuck += 1

      if (activityMs(row) >= todayMs) {
        if (row.status === 'failed') failedToday += 1
        else if (row.status === 'succeeded') succeededToday += 1
      }
    }

    return { running, pending, failedToday, succeededToday, stuck }
  }, [visibleRows])

  const hasActiveFilters = FILTER_KEYS.some((key) => String(filters[key] ?? '').trim() !== '')

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE))
  // Clamped here as well as in the effect below: the feed re-polls every two seconds, and a render
  // that slices past the end of a shrunken result set would blank the grid for a frame first.
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * PAGE_SIZE

  const pagedRows = useMemo(
    () => visibleRows.slice(pageStart, pageStart + PAGE_SIZE),
    [visibleRows, pageStart],
  )

  // Any change to what is being filtered invalidates the reader's place in the results -- page 7 of
  // the old set is meaningless in the new one, and is frequently past its end.
  useEffect(() => {
    setPage(1)
  }, [filters, showAutoRejected])

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount))
  }, [pageCount])

  function goToPage(next: number) {
    setPage(Math.min(Math.max(next, 1), pageCount))
    scrollGridToTop()
  }

  function scrollGridToTop() {
    const node = gridRef.current
    if (!node) return
    // Honour the same preference the CSS animations do -- a smooth scroll is motion too.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }

  function jumpToLatest() {
    setPage(1)
    scrollGridToTop()
  }

  // Rebind the drawer to the freshest copy of its row on every poll so an open drawer keeps
  // ticking with the feed. If the row drops out of the current filter set entirely, hold the last
  // known copy rather than yanking the drawer shut under the reader.
  // Deep link: /deployments?d=<deploymentId> (with r+e or b as fallbacks). Opens that
  // deployment's drawer and pages to it, so a link pasted into Teams lands on the exact tile
  // rather than the top of an 91-item board.
  useEffect(() => {
    if (deepLinkHandled.current || rows.length === 0) return
    const wanted = ['d', 'r', 'b'].some((k) => searchParams.get(k))
    if (!wanted) return
    const hit = rows.find((row) => matchesTileLink(row, searchParams))
    if (!hit) return
    deepLinkHandled.current = true
    setSelected(hit)
    // The target may be filtered out of the current page, so jump to the page it is actually on.
    const idx = visibleRows.findIndex((row) => row.id === hit.id)
    if (idx >= 0) setPage(Math.floor(idx / PAGE_SIZE) + 1)
    // Drop the params once consumed: a stale link in the URL should not keep re-opening the drawer
    // after the user closes it, and the address bar stays clean for the next share.
    const next = new URLSearchParams(searchParams)
    for (const k of ['d', 'r', 'e', 'b']) next.delete(k)
    setSearchParams(next, { replace: true })
  }, [rows, visibleRows, searchParams, setSearchParams])

  const selectedRow = selected ? rows.find((row) => row.id === selected.id) ?? selected : null

  const tiles = [
    { key: 'running', label: 'In progress', value: summary.running, tone: styles.toneBlue },
    { key: 'pending', label: 'Queued / waiting', value: summary.pending, tone: styles.toneAmber },
    { key: 'failed', label: 'Failed today', value: summary.failedToday, tone: styles.toneRed },
    { key: 'succeeded', label: 'Succeeded today', value: summary.succeededToday, tone: styles.toneGreen },
    { key: 'stuck', label: 'Stuck', value: summary.stuck, tone: styles.toneRed },
  ]

  return (
    <main className={pageStyles.main}>
      <AdoUnreachableBanner
        reachable={data?.adoReachable}
        error={data?.adoError}
        failedSince={data?.adoFailedSince}
      />
      <header className={styles.head}>
        <div className={styles.headTitle}>
          <h1 className={styles.title}>Live Deployments</h1>
          <p className={styles.subtitle}>
            Every release deployment across ECom and Macula, read-only and refreshed automatically.
          </p>
        </div>

        <div className={styles.headControls}>
          <span className={styles.updated}>
            <span
              className={[styles.dot, styles.dotLive, isFetching && styles.dotFetching]
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            />
            {/* The backend sends a bare HH:MM:SS already converted to IST, so it passes straight
                through formatTimestamp (which only reformats parseable ISO strings). Labelled so it
                cannot be mistaken for the viewer's own clock. */}
            Last updated: {data?.updated ? `${formatTimestamp(data.updated)} IST` : '…'}
          </span>

          <span className={styles.refreshLabel}>Auto-refresh 2s</span>
        </div>
      </header>

      <div className={styles.summary}>
        {tiles.map((tile) => (
          <div
            key={tile.key}
            className={[
              styles.tile,
              tile.tone,
              tile.key === 'stuck' && tile.value > 0 && styles.tileAlert,
              tile.value === 0 && styles.tileZero,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className={styles.tileValue}>{tile.value}</span>
            <span className={styles.tileLabel}>{tile.label}</span>
          </div>
        ))}
      </div>

      <DeploymentFilters
        filters={filters}
        onChange={setFilters}
        onClear={() => setFilters(EMPTY_FILTERS)}
        resultCount={visibleRows.length}
        showAutoRejected={showAutoRejected}
        onShowAutoRejectedChange={setShowAutoRejected}
        hiddenAutoRejectedCount={hiddenAutoRejectedCount}
        autoRejectedForced={autoRejectedForced}
        canHideTiles={isAdmin}
        showHiddenTiles={showHidden}
        onShowHiddenTilesChange={setShowHidden}
        hiddenTileCount={hiddenCount}
        hiddenTileTotal={hiddenTotal}
      />

      {isError ? (
        <p className={pageStyles.error}>{(error as Error).message}</p>
      ) : isLoading ? (
        <>
          <p className={pageStyles.loading}>Loading deployments…</p>
          {/* Placeholders only -- the line above is what a screen reader should hear, so the
              skeleton grid stays out of the accessibility tree entirely. */}
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className={styles.skeleton} />
            ))}
          </div>
        </>
      ) : visibleRows.length === 0 ? (
        <EmptyState
          hasFilters={hasActiveFilters}
          hiddenAutoRejectedCount={hiddenAutoRejectedCount}
          onClear={() => setFilters(EMPTY_FILTERS)}
          onShowAutoRejected={() => setShowAutoRejected(true)}
        />
      ) : (
        <>
          <div className={styles.grid} ref={gridRef}>
            {/* index is the position within the page, not the result set, so the entrance stagger
                restarts at zero on every page instead of inheriting a 25-card head start. */}
            {pagedRows.map((row, index) => (
              <DeploymentCard
                key={row.id}
                row={row}
                index={index}
                onOpen={setSelected}
                canHide={isAdmin}
              />
            ))}
          </div>

          <div className={styles.pager}>
            <span className={styles.pagerRange}>
              Showing {pageStart + 1}-{pageStart + pagedRows.length} of {visibleRows.length}
            </span>

            {pageCount > 1 && (
              <nav className={styles.pagerNav} aria-label="Deployment pages">
                <button
                  type="button"
                  className={styles.pagerButton}
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage === 1}
                >
                  Previous
                </button>

                {pageWindow(currentPage, pageCount).map((item, index) =>
                  item === 'gap' ? (
                    <span key={`gap-${index}`} className={styles.pagerGap} aria-hidden="true">
                      …
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      className={
                        item === currentPage
                          ? `${styles.pagerButton} ${styles.pagerButtonActive}`
                          : styles.pagerButton
                      }
                      aria-label={`Page ${item}`}
                      aria-current={item === currentPage ? 'page' : undefined}
                      onClick={() => goToPage(item)}
                    >
                      {item}
                    </button>
                  ),
                )}

                <button
                  type="button"
                  className={styles.pagerButton}
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage === pageCount}
                >
                  Next
                </button>
              </nav>
            )}

            {currentPage > 1 && (
              <button type="button" className={styles.jumpButton} onClick={jumpToLatest}>
                Jump to latest
              </button>
            )}
          </div>

          {/* Duplicate of the pager's control: on page 9 of a long feed the pager is a long scroll
              away, and getting back to the live rows is the one thing that must always be one
              click. Hidden from the accessibility tree because the pager already exposes it. */}
          {currentPage > 1 && (
            <button
              type="button"
              className={styles.jumpFloat}
              onClick={jumpToLatest}
              tabIndex={-1}
              aria-hidden="true"
            >
              Jump to latest
            </button>
          )}
        </>
      )}

      {selectedRow && <DeploymentDetailDrawer row={selectedRow} onClose={() => setSelected(null)} />}
    </main>
  )
}
