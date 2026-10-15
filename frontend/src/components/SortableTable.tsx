import { useMemo, useState } from 'react'
import styles from './SortableTable.module.css'

export interface Column<T> {
  key: string
  label: string
  /** Value used for sorting when this column's header is clicked. Omit for a non-sortable column. */
  sortValue?: (row: T) => string | number
  render: (row: T) => React.ReactNode
  /** Fixed column width (any CSS width value, e.g. "160px"). Omit to let the browser distribute
   * remaining space across un-widthed columns -- used for the one or two columns per table that
   * should flex (typically Branch). Requires table-layout: fixed (set globally in the module CSS)
   * to actually take effect reliably. */
  width?: string
  /** Truncate long content with an ellipsis instead of wrapping/overflowing the table -- for
   * columns like Branch, where a long feature-branch name would otherwise blow out the layout or
   * get clipped hard against the table's edge. */
  truncate?: boolean
  /** Plain-text value for the truncated cell's title attribute, so the full value is still
   * available on hover. Only meaningful alongside truncate: true. */
  title?: (row: T) => string
}

interface SortableTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  getRowKey: (row: T) => string
  emptyMessage: string
  defaultSortKey?: string
  defaultSortDir?: 1 | -1
}

/** Generic sortable table -- click a header to sort by it, click again to reverse. Replaces the
 * old vanilla-JS version's hand-rolled liveSort/cmpVal/renderLive string-templating with real
 * component state, reused by both the Live Status sections and the My Deployments table. */
export function SortableTable<T>({
  columns,
  rows,
  getRowKey,
  emptyMessage,
  defaultSortKey,
  defaultSortDir = 1,
}: SortableTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey)
  const [sortDir, setSortDir] = useState<1 | -1>(defaultSortDir)

  const sortedRows = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey)
    if (!col?.sortValue) return rows
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a)
      const bv = col.sortValue!(b)
      if (av < bv) return -1 * sortDir
      if (av > bv) return 1 * sortDir
      return 0
    })
  }, [rows, columns, sortKey, sortDir])

  function handleHeaderClick(col: Column<T>) {
    if (!col.sortValue) return
    if (sortKey === col.key) {
      setSortDir((d) => (d === 1 ? -1 : 1))
    } else {
      setSortKey(col.key)
      setSortDir(1)
    }
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <colgroup>
          {columns.map((col) => (
            <col key={col.key} style={col.width ? { width: col.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} onClick={() => handleHeaderClick(col)}>
                {col.label}
                {sortKey === col.key && (
                  /* Drawn rather than a text glyph: the geometric-shape characters render at wildly
                     different baselines and weights across fonts, and an SVG matches how every other
                     icon in this app is done. */
                  <svg
                    className={styles.arrow}
                    viewBox="0 0 10 6"
                    width="8"
                    height="5"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d={sortDir === 1 ? 'M1 5L5 1l4 4' : 'M1 1l4 4 4-4'}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={styles.empty}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => (
              <tr key={getRowKey(row)}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={col.truncate ? styles.truncateCell : undefined}
                    title={col.truncate ? col.title?.(row) : undefined}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
