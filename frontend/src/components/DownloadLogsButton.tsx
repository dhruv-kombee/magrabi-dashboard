import { useEffect, useRef, useState } from 'react'
import type { MyDeploymentRow } from '../api/types'
import { allLogsUrl, failedSectionLogsUrl } from '../api/client'
import styles from './DownloadLogsButton.module.css'

// approvalTimedOut is deliberately NOT here: nothing ran, so there are no deployment logs to
// download -- offering the button would hand back an empty archive.
const FAILURE_STATUSES = ['failed', 'rejected']

/** Shown only once a deployment has actually failed -- mirrors Azure DevOps' own release logs
 * view, which offers exactly this pair of options ("Download all logs" alongside the specific
 * failed step). Plain download links, not fetch()+blob: the browser handles the download natively
 * via the backend's Content-Disposition header, and the session cookie rides along automatically
 * on a same-origin link click. */
export function DownloadLogsButton({ row }: { row: MyDeploymentRow }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  if (!row.releaseId || !row.pipeline || !row.env || !FAILURE_STATUSES.includes(row.status)) return null

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button className={styles.button} onClick={() => setOpen((o) => !o)}>
        Logs
        {/* Rotates to point up while the menu is open, so the control shows its own state. */}
        <svg
          viewBox="0 0 10 6"
          width="9"
          height="6"
          aria-hidden="true"
          focusable="false"
          className={open ? `${styles.caret} ${styles.caretOpen}` : styles.caret}
        >
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className={styles.menu}>
          <a
            className={styles.menuItem}
            href={failedSectionLogsUrl(row.releaseId, row.env, row.pipeline)}
            onClick={() => setOpen(false)}
          >
            Download failed section
          </a>
          <a className={styles.menuItem} href={allLogsUrl(row.releaseId, row.pipeline)} onClick={() => setOpen(false)}>
            Download all logs
          </a>
        </div>
      )}
    </div>
  )
}
