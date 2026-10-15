import { useCallback, useState } from 'react'
import { FeedbackModal } from './FeedbackModal'
import styles from './FeedbackButton.module.css'

/** Nav-bar entry point to the submit form. Renders for BOTH roles on purpose -- raising a request
 * is the one feedback capability a viewer has, while the triage inbox at /feedback is admin-only.
 * The open/closed state lives here rather than in NavHeader so the header stays pure layout and
 * the modal has exactly one owner. */
export function FeedbackButton() {
  const [open, setOpen] = useState(false)
  // Stable identity matters: the modal's post-success auto-close runs on a timer effect keyed to
  // onClose, and a fresh arrow function each render would restart that timer instead of letting
  // it fire. Same reason its Escape listener would otherwise be torn down and re-added constantly.
  const close = useCallback(() => setOpen(false), [])

  return (
    <>
      <button type="button" className={styles.button} onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" className={styles.icon} aria-hidden="true">
          <path d="M20 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3v4l5-4h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z" />
        </svg>
        Raise request
      </button>
      {open && <FeedbackModal onClose={close} />}
    </>
  )
}
