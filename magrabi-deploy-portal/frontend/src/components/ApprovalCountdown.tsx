import { useEffect, useState } from 'react'
import styles from './ApprovalCountdown.module.css'

/** Time left before Azure DevOps auto-rejects an open approval gate.
 *
 * This exists because the window is genuinely tiny: the pre-deploy approval on nearly every ECom
 * stage is configured at ONE MINUTE (def 41's UAT is the lone 10-minute exception), and 95% of all
 * rejected approvals in the project are ADO auto-rejects against that limit rather than a person
 * declining. A static "awaiting approval" badge gives no sense that the row is expiring while you
 * read it.
 *
 * The deadline is computed server-side from ADO's own approval createdOn, so this does not drift
 * with when the page last polled -- the browser only renders the remainder.
 */
export function ApprovalCountdown({ deadline }: { deadline: string | null }) {
  const target = deadline ? new Date(deadline).getTime() : NaN
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!Number.isFinite(target)) return
    // 1s tick: the whole point is watching seconds disappear. Cleared as soon as the row stops
    // being a pending one, because this component unmounts with it.
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [target])

  if (!Number.isFinite(target)) return null

  const secondsLeft = Math.round((target - now) / 1000)
  if (secondsLeft <= 0) {
    // Held rather than hidden: ADO's sweep is not instant, so the row can legitimately sit here for
    // a few seconds before it flips to approval timed out. Saying "expiring" is honest about that;
    // showing a negative number or nothing at all is not.
    return <span className={`${styles.countdown} ${styles.expired}`}>expiring…</span>
  }

  const urgent = secondsLeft <= 20
  const label =
    secondsLeft >= 60
      ? `${Math.floor(secondsLeft / 60)}m ${String(secondsLeft % 60).padStart(2, '0')}s left`
      : `${secondsLeft}s left`

  return (
    <span
      className={`${styles.countdown} ${urgent ? styles.urgent : ''}`}
      title="Azure DevOps will auto-reject this approval when the timer runs out"
    >
      {label}
    </span>
  )
}
