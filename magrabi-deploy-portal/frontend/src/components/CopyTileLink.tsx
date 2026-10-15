import { useState } from 'react'
import type { DeploymentRow, MyDeploymentRow } from '../api/types'
import styles from './CopyTileLink.module.css'

/** The identifiers a deep link needs. Deliberately not a specific row type: the deployments board
 * and the My Deployments tables hold different shapes for the same underlying deployment. */
export type LinkTarget = {
  id?: number
  releaseId: number
  rawEnv: string
  buildNumber: string
}

/** The shareable address of one deployment tile.
 *
 * Carries several identifiers because they fail in different ways:
 *   d      = ADO deployment id, exact and stable once a release exists
 *   r + e  = releaseId + raw environment, which still resolve the tile if the deployment id has
 *            aged out of the recipient's feed window
 *   b      = build number, for a tile whose CI build is still running and has no release yet --
 *            and which keeps working after the release appears, because the build number carries
 *            over even though the synthetic id does not
 */
export function tileLinkFor(target: LinkTarget): string {
  const params = new URLSearchParams()
  if (target.id) params.set('d', String(target.id))
  if (target.releaseId > 0) {
    params.set('r', String(target.releaseId))
    if (target.rawEnv) params.set('e', target.rawEnv)
  } else if (target.buildNumber) {
    params.set('b', target.buildNumber)
  }
  return `${window.location.origin}/deployments?${params.toString()}`
}

/** Does this row match a deep link? Tried widest-first so an older link still lands somewhere
 * sensible after the deployment id has aged out of the feed. */
export function matchesTileLink(row: DeploymentRow, params: URLSearchParams): boolean {
  const d = params.get('d')
  if (d && String(row.id) === d) return true
  const r = params.get('r')
  const e = params.get('e')
  if (r && String(row.releaseId) === r && (!e || row.rawEnv === e)) return true
  const b = params.get('b')
  if (b && row.buildNumber === b) return true
  return false
}

/** What to call a deployment's state in a chat message. Present tense while it is happening, and
 * "Done." once finished -- these are the words the team already types by hand, so a pasted line is
 * indistinguishable from a typed one. */
const STATUS_WORD: Record<string, string> = {
  queued: 'Queued',
  building: 'Building',
  'creating-release': 'Preparing release',
  rebuilding: 'Rebuilding',
  waiting: 'Waiting',
  'ready-for-approval': 'Awaiting approval',
  pendingApproval: 'Awaiting approval',
  approvalTimedOut: 'Approval timed out',
  inProgress: 'Deploying',
  succeeded: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
  rejected: 'Rejected',
  notDeployed: 'Not deployed',
}

/** The line the team pastes into Teams, split into its two halves.
 *
 * The split matters for how it renders in chat: only the identity half is wrapped in the link, so
 * the status word stays BOLD and in the normal text colour instead of being swallowed into the blue
 * underlined run. Reading "... Branch - promotion/uat Done." with "Done." in link blue made the
 * outcome look like part of the address rather than the point of the message.
 *
 * The wording and spacing match what the team already sends by hand; do not "tidy" them.
 */
export function deploymentLinkText(parts: {
  env?: string | null
  pipeline?: string | null
  branch?: string | null
}): string {
  return `Env - ${parts.env ?? ''} , Pipeline - ${parts.pipeline ?? ''} , Branch - ${parts.branch ?? ''}`
}

export function deploymentStatusWord(status: string): string {
  return `${STATUS_WORD[status] ?? status}.`
}

/** Statuses worth reporting at all. Anything still moving has no outcome to announce, so the batch
 * button counts only these rather than claiming a result that has not happened. */
const REPORTABLE = new Set(['succeeded', 'failed', 'rejected', 'canceled', 'approvalTimedOut'])
export function isCopyable(row: { status?: string }): boolean {
  return REPORTABLE.has(row.status ?? '')
}

export type CopyItem = { target: LinkTarget; linkText: string; statusWord: string }

export function itemForTile(row: DeploymentRow): CopyItem {
  return {
    target: {
      id: row.id,
      releaseId: row.releaseId,
      rawEnv: row.rawEnv,
      buildNumber: row.buildNumber,
    },
    linkText: deploymentLinkText({
      env: row.env,
      pipeline: row.pipeline || row.definitionName,
      branch: row.branch,
    }),
    statusWord: deploymentStatusWord(row.status),
  }
}

export function itemForRun(row: MyDeploymentRow): CopyItem {
  return {
    // The portal's env IS the ADO stage name for the lower environments these rows cover.
    target: { releaseId: row.releaseId ?? 0, rawEnv: row.env ?? '', buildNumber: row.buildNumber },
    linkText: deploymentLinkText({ env: row.env, pipeline: row.pipeline, branch: row.branch }),
    statusWord: deploymentStatusWord(row.status),
  }
}

/** Writes BOTH a rich-text and a plain-text flavour to the clipboard.
 *
 * Teams prefers text/html, so writing only a URL produced a bare unreadable link. With an <a> in
 * the html flavour the message reads as the full line and still clicks through to the exact tile.
 * The plain flavour keeps the same wording for anywhere that does not accept html.
 */
async function writeRich(html: string, plain: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ])
      return true
    }
  } catch {
    /* fall through to the selection-based route */
  }
  // Fallback: copying a SELECTION carries rich text where the async API is unavailable or blocked.
  try {
    const holder = document.createElement('div')
    holder.innerHTML = html
    holder.setAttribute('contenteditable', 'true')
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.appendChild(holder)
    const range = document.createRange()
    range.selectNodeContents(holder)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    const ok = document.execCommand('copy')
    sel?.removeAllRanges()
    document.body.removeChild(holder)
    return ok
  } catch {
    return false
  }
}

/** Line separator for the plain-text flavour. Named rather than inlined so the escape
 * survives future edits to this file. */
const NEWLINE = String.fromCharCode(10)

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/** One button, one behaviour, everywhere: copies each line as a hyperlink titled with the full
 * Env / Pipeline / Branch / status line, pointing at that deployment's tile on the board. */
export function CopyLinkButton({ items, label = 'Copy' }: { items: CopyItem[]; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')

  // Nothing to point at yet -- a run with no release and no build has no stable handle.
  const usable = items.filter((i) => i.target.releaseId || i.target.buildNumber || i.target.id)
  if (usable.length === 0) return null

  async function onClick(e: React.MouseEvent) {
    // On a card the whole tile is a button that opens the drawer; copying must not also open it.
    e.stopPropagation()
    // Only the identity half goes inside the <a>. The status word follows as <strong>, so chat
    // renders it bold in the normal text colour instead of swallowing it into the blue underlined
    // run -- the outcome is the point of the message, not part of the address.
    const html = usable
      .map(
        (i) =>
          `<div><a href="${escapeHtml(tileLinkFor(i.target))}">${escapeHtml(i.linkText)}</a>` +
          ` <strong>${escapeHtml(i.statusWord)}</strong></div>`,
      )
      .join('')
    const plain = usable
      .map((i) => `${i.linkText} ${i.statusWord} ${tileLinkFor(i.target)}`)
      .join(NEWLINE)
    const ok = await writeRich(html, plain)
    setState(ok ? 'ok' : 'fail')
    window.setTimeout(() => setState('idle'), 1600)
  }

  return (
    <button
      className={`${styles.button} ${state === 'ok' ? styles.ok : ''} ${state === 'fail' ? styles.fail : ''}`}
      onClick={onClick}
      title={`Copies: ${usable[0].linkText} ${usable[0].statusWord}`}
    >
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  )
}

export function CopyTileLink({ row }: { row: DeploymentRow }) {
  return <CopyLinkButton items={[itemForTile(row)]} label="Copy link" />
}
