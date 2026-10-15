import { useEffect, useRef, type ReactNode } from 'react'
import styles from './KeyRotationConfirm.module.css'

/** The confirm-before-write dialog, in the same shape the Variables page uses inline.
 *
 * Pulled out into a component here because this section has THREE writes that each need it (sync,
 * rollback, and a preview that is one click away from either), and because the rollback variant has
 * to look materially more dangerous than the sync variant. Duplicating the markup three times is
 * how one of them quietly ends up without a confirmation at all.
 *
 * No value ever reaches this component -- it takes counts and names. That is deliberate: a
 * confirmation listing credentials would be the easiest place in the whole section for a secret to
 * leak onto a shared screen.
 */
export function KeyRotationConfirm({
  title,
  confirmLabel,
  danger = false,
  busy = false,
  onCancel,
  onConfirm,
  children,
}: {
  title: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
  children: ReactNode
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // Focus lands on Cancel, not on the write button. Someone who hit Enter a moment too early, or
  // who is driving this by keyboard, must not be one keystroke from writing a production
  // definition. Escape closes, so there is always a way out that is not the dangerous one.
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className={styles.backdrop} onClick={onCancel} role="presentation">
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyrotation-confirm-title"
      >
        <h2 id="keyrotation-confirm-title" className={styles.dialogTitle}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        <p className={styles.note}>
          Values are not shown here on purpose. This writes release <strong>definitions</strong>
          only — nothing reaches a running service until somebody creates a release, and anything
          built into an image needs a rebuild rather than a redeploy.
        </p>
        <div className={styles.actions}>
          <button type="button" ref={cancelRef} className={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? styles.confirmDanger : styles.confirm}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
