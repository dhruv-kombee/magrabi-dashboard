import { useId } from 'react'
import type { DeploymentFilters as DeploymentFiltersType } from '../api/types'
import { usePortalMetaQuery } from '../api/hooks'
import { STATUS_LABELS } from './DeploymentStatusPill'
import styles from './DeploymentFilters.module.css'

/** Every filter key the feed understands, in one place. The page reads this to decide whether the
 * "no results" state should offer a reset, so the two views can never disagree about what counts
 * as an active filter. */
export const FILTER_KEYS = ['search', 'env', 'application', 'pipeline', 'status', 'from', 'to'] as const

export const EMPTY_FILTERS: DeploymentFiltersType = {
  search: '',
  env: '',
  application: '',
  pipeline: '',
  status: '',
  from: '',
  to: '',
}

// Used until /api/meta answers, and as a floor if it ever comes back short: the environment buckets
// and normalized statuses are fixed by the backend contract, so hardcoding them here is safe in a
// way that hardcoding pipeline or application names would not be.
const FALLBACK_ENVIRONMENTS = ['DEV', 'SIT', 'UAT', 'PROD', 'OTHER']
const FALLBACK_STATUSES = Object.keys(STATUS_LABELS)

function isSet(value: unknown): boolean {
  return String(value ?? '').trim() !== ''
}

export interface DeploymentFiltersProps {
  filters: DeploymentFiltersType
  onChange: (next: DeploymentFiltersType) => void
  onClear: () => void
  /** Rows actually on screen, i.e. after the auto-rejected hide has been applied. */
  resultCount: number
  showAutoRejected: boolean
  onShowAutoRejectedChange: (next: boolean) => void
  /** How many rows the hide is currently withholding. Rendered whenever it is non-zero so the
   * suppression is never silent. */
  hiddenAutoRejectedCount: number
  /** True when an explicit Status: Rejected filter is showing these rows regardless of the
   * toggle -- the page decides this, the bar only has to explain it. */
  autoRejectedForced: boolean
  /** Admin only: whether to offer the manually-hidden-tiles control at all. */
  canHideTiles?: boolean
  showHiddenTiles?: boolean
  onShowHiddenTilesChange?: (next: boolean) => void
  /** Manually hidden tiles matching the current filters, and in total. Both come from the server,
   * which is the only place that knows -- the rows themselves never reach a non-admin client. */
  hiddenTileCount?: number
  hiddenTileTotal?: number
}

export function DeploymentFilters({
  filters,
  onChange,
  onClear,
  resultCount,
  showAutoRejected,
  onShowAutoRejectedChange,
  hiddenAutoRejectedCount,
  autoRejectedForced,
  canHideTiles = false,
  showHiddenTiles = false,
  onShowHiddenTilesChange,
  hiddenTileCount = 0,
  hiddenTileTotal = 0,
}: DeploymentFiltersProps) {
  const { data: meta, isLoading: metaLoading } = usePortalMetaQuery()
  const fieldId = useId()

  const activeCount = FILTER_KEYS.filter((key) => isSet(filters[key])).length
  const environments = meta?.environments?.length ? meta.environments : FALLBACK_ENVIRONMENTS
  const statuses = meta?.statuses?.length ? meta.statuses : FALLBACK_STATUSES
  const pipelines = meta?.pipelines ?? []
  const applications = meta?.applications ?? []

  const searchValue = String(filters.search ?? '')

  return (
    <section className={styles.bar} aria-label="Deployment filters">
      <div className={styles.searchRow}>
        <div className={styles.searchWrap}>
          <svg
            className={styles.searchIcon}
            viewBox="0 0 14 14"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="6.2" cy="6.2" r="4.2" />
            <path d="M9.4 9.4 L12.4 12.4" />
          </svg>
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search pipeline, release, branch, build, commit, person…"
            aria-label="Search deployments"
            value={searchValue}
            onChange={(event) => onChange({ ...filters, search: event.target.value })}
          />
          {searchValue !== '' && (
            <button
              type="button"
              className={styles.clearSearch}
              aria-label="Clear search"
              onClick={() => onChange({ ...filters, search: '' })}
            >
              <svg
                viewBox="0 0 10 10"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M2.2 2.2 L7.8 7.8 M7.8 2.2 L2.2 7.8" />
              </svg>
            </button>
          )}
        </div>

        <div className={styles.actions}>
          <span className={styles.count}>
            {resultCount} {resultCount === 1 ? 'deployment' : 'deployments'}
          </span>
          {activeCount > 0 && (
            <span className={styles.activeBadge}>
              {activeCount} {activeCount === 1 ? 'filter' : 'filters'} active
            </span>
          )}
          <button type="button" className={styles.clearAll} onClick={onClear} disabled={activeCount === 0}>
            Clear all
          </button>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-env`}>
            Environment
          </label>
          <select
            id={`${fieldId}-env`}
            className={styles.select}
            value={String(filters.env ?? '')}
            onChange={(event) => onChange({ ...filters, env: event.target.value })}
          >
            <option value="">All environments</option>
            {environments.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-application`}>
            Application
          </label>
          <select
            id={`${fieldId}-application`}
            className={styles.select}
            value={String(filters.application ?? '')}
            disabled={metaLoading && applications.length === 0}
            onChange={(event) => onChange({ ...filters, application: event.target.value })}
          >
            <option value="">All applications</option>
            {applications.map((application) => (
              <option key={application} value={application}>
                {application}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-pipeline`}>
            Pipeline
          </label>
          <select
            id={`${fieldId}-pipeline`}
            className={styles.select}
            value={String(filters.pipeline ?? '')}
            disabled={metaLoading && pipelines.length === 0}
            onChange={(event) => onChange({ ...filters, pipeline: event.target.value })}
          >
            <option value="">All pipelines</option>
            {pipelines.map((pipeline) => (
              <option key={pipeline} value={pipeline}>
                {pipeline}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-status`}>
            Status
          </label>
          <select
            id={`${fieldId}-status`}
            className={styles.select}
            value={String(filters.status ?? '')}
            onChange={(event) => onChange({ ...filters, status: event.target.value })}
          >
            <option value="">Any status</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status] ?? status}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-from`}>
            From
          </label>
          <input
            id={`${fieldId}-from`}
            type="date"
            className={styles.select}
            value={String(filters.from ?? '')}
            // The backend clamps the range itself; capping the input keeps the picker from
            // offering a "from" that is already past the chosen "to".
            max={String(filters.to ?? '') || undefined}
            onChange={(event) => onChange({ ...filters, from: event.target.value })}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-to`}>
            To
          </label>
          <input
            id={`${fieldId}-to`}
            type="date"
            className={styles.select}
            value={String(filters.to ?? '')}
            min={String(filters.from ?? '') || undefined}
            onChange={(event) => onChange({ ...filters, to: event.target.value })}
          />
        </div>
      </div>

      <div className={styles.noiseRow}>
        {/* The box is ticked and locked while an explicit Status: Rejected filter is on, because
            that filter really is showing these rows -- leaving it unticked would describe the
            opposite of what is on screen. The stored preference underneath is untouched and comes
            back as soon as the status filter is cleared. */}
        <label className={styles.toggle} htmlFor={`${fieldId}-auto-rejected`}>
          <input
            id={`${fieldId}-auto-rejected`}
            type="checkbox"
            className={styles.toggleInput}
            checked={showAutoRejected || autoRejectedForced}
            disabled={autoRejectedForced}
            onChange={(event) => onShowAutoRejectedChange(event.target.checked)}
          />
          <span className={styles.toggleText}>Show auto-rejected (no approval)</span>
        </label>

        {autoRejectedForced ? (
          <span className={styles.noiseNote}>Shown by the Rejected status filter.</span>
        ) : hiddenAutoRejectedCount > 0 ? (
          <span className={styles.hiddenBadge}>{hiddenAutoRejectedCount} auto-rejected hidden</span>
        ) : (
          <span className={styles.noiseNote}>
            {showAutoRejected ? 'Auto-rejected deployments are included below.' : 'None in this result set.'}
          </span>
        )}
      </div>

      {/* Manually hidden tiles. Admin-only, and a separate row from the auto-rejected control on
          purpose: that one filters noise ADO generated, this one withholds real deployments because
          a person decided to. Conflating them would make a deliberate edit look automatic. */}
      {canHideTiles && (
        <div className={styles.noiseRow}>
          <label className={styles.toggle} htmlFor={`${fieldId}-hidden-tiles`}>
            <input
              id={`${fieldId}-hidden-tiles`}
              type="checkbox"
              className={styles.toggleInput}
              checked={showHiddenTiles}
              onChange={(event) => onShowHiddenTilesChange?.(event.target.checked)}
            />
            <span className={styles.toggleText}>Show tiles hidden by an admin</span>
          </label>

          {hiddenTileCount > 0 ? (
            <span className={styles.hiddenBadge}>
              {hiddenTileCount} hidden here{
                hiddenTileTotal > hiddenTileCount ? ` (${hiddenTileTotal} in total)` : ''
              }
            </span>
          ) : hiddenTileTotal > 0 ? (
            <span className={styles.noiseNote}>
              {hiddenTileTotal} hidden elsewhere — none match these filters.
            </span>
          ) : (
            <span className={styles.noiseNote}>Nothing is hidden.</span>
          )}
        </div>
      )}
    </section>
  )
}
