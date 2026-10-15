import { useState } from 'react'
import styles from './CommitCell.module.css'

/** The Commit column: short hash in the table, full SHA in a dialog.
 *
 * The column shows the abbreviated form because a 40-character hash is unreadable at a glance and
 * would blow the column width on a seven-column table. But the short form is not what you paste
 * into `git show` or a Jira comment, so the full value has to be reachable -- one click, with a
 * copy button, rather than sending someone to Azure DevOps to fetch it.
 */
export function CommitCell({ short, full }: { short: string; full?: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!short) return <span className={styles.dash}>-</span>

  // No full SHA on this row (placeholder rows carry neither) -- render it inert rather than
  // offering a dialog that would open onto nothing.
  if (!full || full === short) return <code className={styles.commit}>{short}</code>

  async function copy() {
    try {
      await navigator.clipboard.writeText(full as string)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked -- the value is on screen and selectable anyway */
    }
  }

  return (
    <>
      <button
        className={styles.trigger}
        onClick={() => setOpen(true)}
        title="Show the full commit SHA"
      >
        <code className={styles.commit}>{short}</code>
      </button>

      {open && (
        <div
          className={styles.backdrop}
          onClick={() => setOpen(false)}
          role="presentation"
        >
          {/* Stops a click inside the dialog closing it via the backdrop handler. */}
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.head}>
              <h3 className={styles.title}>Commit</h3>
              <button className={styles.close} onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <p className={styles.note}>
              The commit this release was built from, as recorded by Azure DevOps.
            </p>
            <code className={styles.full}>{full}</code>
            <div className={styles.actions}>
              <button className={styles.copy} onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy full SHA'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
