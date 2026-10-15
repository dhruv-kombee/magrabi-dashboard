import styles from './LiveStatusControls.module.css'

// PROD is READ-ONLY here -- this list only drives what the status view displays. The portal's
// deploy-trigger safety gate lives entirely in the backend's separate ENVIRONMENTS constant
// (DEV/SIT/UAT only) and is untouched by this list; there is no route in this app that can act on
// whatever "PROD" row this renders.
// BETA sits between UAT and PROD because that is the promotion order, and because the beta stages
// ("BETA_TAG", "BETA PROD") were previously invisible everywhere in the UI -- bucketed to OTHER or,
// worse, matched into PROD by a bare /prod/ test against the name "BETA PROD".
export const ALL_ENVS = ['DEV', 'SIT', 'UAT', 'BETA', 'PROD'] as const
export type EnvFilter = 'ALL' | (typeof ALL_ENVS)[number]

export const REFRESH_STORAGE_KEY = 'status-refresh-ms'
const DEFAULT_REFRESH_MS = 15_000

/** 0 is the "Off" sentinel -- StatusPage turns it into a disabled query, not just a skipped
 * interval, so that Off genuinely stops polling instead of only hiding it. */
const REFRESH_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Every 5s', ms: 5_000 },
  { label: 'Every 15s', ms: 15_000 },
  { label: 'Every 30s', ms: 30_000 },
  { label: 'Every 60s', ms: 60_000 },
  { label: 'Off', ms: 0 },
]

/** Reads the persisted auto-refresh choice, falling back to the default for anything unrecognised.
 * The explicit null/empty check is load-bearing: Number(null) is 0, and 0 is a *valid* option here
 * ("Off"), so a bare Number() parse would silently turn "never chosen" into "polling disabled". */
export function readStoredRefreshMs(): number {
  const raw = localStorage.getItem(REFRESH_STORAGE_KEY)
  if (raw === null || raw === '') return DEFAULT_REFRESH_MS
  const parsed = Number(raw)
  return REFRESH_OPTIONS.some((o) => o.ms === parsed) ? parsed : DEFAULT_REFRESH_MS
}

export type StatusView = 'tiles' | 'table'

interface LiveStatusControlsProps {
  search: string
  onSearchChange: (value: string) => void
  activeEnv: EnvFilter
  onEnvChange: (env: EnvFilter) => void
  shownCount: number
  totalPipelines: number
  refreshMs: number
  onRefreshMsChange: (ms: number) => void
  updated: string | null | undefined
  isFetching: boolean
  onRefreshNow: () => void
  view: StatusView
  onViewChange: (view: StatusView) => void
}

export function LiveStatusControls({
  search,
  onSearchChange,
  activeEnv,
  onEnvChange,
  shownCount,
  totalPipelines,
  refreshMs,
  onRefreshMsChange,
  updated,
  isFetching,
  onRefreshNow,
  view,
  onViewChange,
}: LiveStatusControlsProps) {
  // Tiles show ONE environment at a time -- that is the point of them, and "All" would stack five
  // grids of 33 cards down one page. So the environment buttons become a straight single-select
  // there, and All only exists for the table.
  const envChoices: EnvFilter[] = view === 'tiles' ? [...ALL_ENVS] : ['ALL', ...ALL_ENVS]
  return (
    <div className={styles.controls}>
      <input
        type="text"
        className={styles.search}
        placeholder="Search application, pipeline, release, branch or build…"
        aria-label="Search live environment status"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <div className={styles.envToggle}>
        {envChoices.map((env) => (
          <button
            key={env}
            type="button"
            className={env === activeEnv ? `${styles.envButton} ${styles.envButtonActive}` : styles.envButton}
            onClick={() => onEnvChange(env)}
          >
            {env === 'ALL' ? 'All' : env}
          </button>
        ))}
      </div>
      {/* Separate group from the environment buttons on purpose: they look alike, and one picks
          WHAT you are looking at while the other picks HOW. */}
      <div className={styles.viewToggle} role="group" aria-label="View">
        {(['tiles', 'table'] as StatusView[]).map((v) => (
          <button
            key={v}
            type="button"
            className={v === view ? `${styles.viewButton} ${styles.viewButtonActive}` : styles.viewButton}
            onClick={() => onViewChange(v)}
            aria-pressed={v === view}
            title={v === 'tiles' ? 'One card per service' : 'Sortable table, all environments'}
          >
            {v === 'tiles' ? 'Tiles' : 'Table'}
          </button>
        ))}
      </div>
      {/* Freshness controls and counters are grouped so they stay together as one block when the
          bar wraps on a narrow window, instead of scattering across two ragged lines. */}
      <div className={styles.meta}>
        <span className={styles.count}>
          {shownCount} shown / {totalPipelines} pipelines total
        </span>
        <span className={styles.updated}>Last updated: {updated ? `${updated} IST` : '…'}</span>
        <label className={styles.refreshGroup}>
          <span className={styles.refreshLabel}>Auto-refresh</span>
          <select
            className={styles.select}
            value={refreshMs}
            onChange={(e) => onRefreshMsChange(Number(e.target.value))}
          >
            {REFRESH_OPTIONS.map((option) => (
              <option key={option.ms} value={option.ms}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={styles.refreshNow} onClick={onRefreshNow} disabled={isFetching}>
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  )
}
