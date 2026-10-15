import { useState } from 'react'
import styles from './CopyDeploymentButton.module.css'

type CopyableRow = {
  env?: string | null
  pipeline?: string | null
  branch?: string | null
  status?: string
}

/** Statuses where the deployment has actually reached an outcome worth reporting to anyone.
 *
 * Everything else -- inProgress, queued, pendingApproval, building -- has NOT finished, and a
 * status line for it would be a claim about something that has not happened yet. The button is
 * hidden entirely for those rather than offered and producing a misleading line.
 */
const FINISHED_OK = new Set(['succeeded'])
const FINISHED_BAD = new Set(['failed', 'rejected', 'canceled', 'approvalTimedOut'])

export function isCopyable(row: CopyableRow): boolean {
  const s = row.status ?? ''
  return FINISHED_OK.has(s) || FINISHED_BAD.has(s)
}

/** Copies one deployment's identity in the shape the team pastes into Teams:
 *
 *     Env - UAT , Pipeline - doctorm-sanity , Branch - promotion/uat Done
 *
 * The trailing word reports the ACTUAL outcome. It used to be hardcoded to "Done", which meant a
 * failed deployment copied as though it had succeeded -- exactly the kind of message that gets
 * believed and then has to be retracted. Wording and spacing of the rest are fixed deliberately so
 * a pasted line is indistinguishable from a typed one; do not "tidy" the spacing.
 */
export function copyText(row: CopyableRow): string {
  const outcome = FINISHED_BAD.has(row.status ?? '') ? 'Failed' : 'Done'
  return `Env - ${row.env ?? ''} , Pipeline - ${row.pipeline ?? ''} , Branch - ${row.branch ?? ''} ${outcome}`
}

/** Clipboard write with a fallback: navigator.clipboard is unavailable on insecure origins and in
 * some embedded browsers, and silently doing nothing there would look like a broken button. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the textarea route */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function CopyDeploymentButton({
  rows,
  label = 'Copy',
  title,
}: {
  /** One row, or every row in a batch -- a batch copies as one line per deployment. */
  rows: CopyableRow[]
  label?: string
  title?: string
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')

  // Only finished deployments are ever copied, even inside a batch where others are still running.
  const finished = rows.filter(isCopyable)
  if (finished.length === 0) return null

  async function onClick() {
    const text = finished.map(copyText).join('\n')
    const ok = await writeClipboard(text)
    setState(ok ? 'ok' : 'fail')
    window.setTimeout(() => setState('idle'), 1600)
  }

  return (
    <button
      className={`${styles.button} ${state === 'ok' ? styles.ok : ''} ${state === 'fail' ? styles.fail : ''}`}
      onClick={onClick}
      title={title ?? `Copy as: ${copyText(finished[0])}`}
    >
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  )
}
