import type { ReactNode } from 'react'
import type { MyDeploymentRow } from '../api/types'
import { CopyLinkButton, itemForRun } from './CopyTileLink'
import { formatTimestamp } from '../utils/format'
import styles from './BatchGroups.module.css'

type Groupable = {
  batchId?: string
  /** Needed so the group's copy button can tell finished rows from mid-flight ones. */
  status?: string
  pipeline?: string | null
  branch?: string | null
  env?: string | null
  startedAt?: string | null
  requestedBy?: string | null
}

export type Block<T> =
  | { kind: 'batch'; key: string; rows: T[] }
  | { kind: 'singles'; key: string; rows: T[] }

/** Orders batches and standalone rows into ONE time-ordered stream.
 *
 * Batches used to be rendered as a lump above the singles table, which meant a batch always floated
 * to the top however old it was -- a deployment started at 18:37 appeared BELOW a batch from 16:30.
 * Sorting the batch and the singles against each other, by the newest row each contains, puts the
 * page back in the order things actually happened.
 *
 * Consecutive standalone rows are merged into one block so the page does not render a separate
 * table (and a separate header) per row. Groups of one are never boxed: a single deployment that
 * happens to carry a batch id is just a row.
 */
export function buildBlocks<T extends Groupable>(rows: T[]): Block<T>[] {
  const byKey = new Map<string, T[]>()
  const loose: T[] = []
  for (const r of rows) {
    const k = r.batchId || ''
    if (!k) {
      loose.push(r)
      continue
    }
    const list = byKey.get(k)
    if (list) list.push(r)
    else byKey.set(k, [r])
  }

  const when = (r: T) => r.startedAt ?? ''
  type Item = { ts: string; kind: 'batch' | 'single'; key: string; rows: T[] }
  const items: Item[] = []
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      // A batch sorts by its newest member, so it sits where the work actually happened.
      const ts = list.reduce((acc, r) => (when(r) > acc ? when(r) : acc), '')
      items.push({ ts, kind: 'batch', key, rows: list })
    } else {
      loose.push(list[0])
    }
  }
  // Cluster the remaining rows by NAME within a short window. Deployments started separately but
  // given the same name minutes apart are, in practice, one piece of work -- and the name is very
  // often set AFTER the fact, so there is no submission to have grouped them by. Grouping them
  // makes "these ran together, by this person" readable at a glance, exactly like a real batch.
  const NAME_WINDOW_MS = 5 * 60 * 1000
  const named = new Map<string, T[]>()
  const anonymous: T[] = []
  for (const r of loose) {
    const nm = (r.requestedBy ?? '').trim()
    if (!nm || nm === '-------') {
      anonymous.push(r)
      continue
    }
    const list = named.get(nm)
    if (list) list.push(r)
    else named.set(nm, [r])
  }
  for (const [nm, list] of named) {
    // Newest first, then split wherever the gap exceeds the window.
    list.sort((a: T, b: T) => when(b).localeCompare(when(a)))
    let run = [list[0]]
    for (let i = 1; i < list.length; i += 1) {
      const gap = Math.abs(new Date(when(run[run.length - 1])).getTime()
                         - new Date(when(list[i])).getTime())
      if (Number.isFinite(gap) && gap <= NAME_WINDOW_MS) {
        run.push(list[i])
      } else {
        pushRun(run)
        run = [list[i]]
      }
    }
    pushRun(run)

    function pushRun(group: T[]) {
      if (group.length > 1) {
        const ts = group.reduce((acc: string, r: T) => (when(r) > acc ? when(r) : acc), '')
        items.push({ ts, kind: 'batch', key: `name:${nm}:${ts}`, rows: group })
      } else {
        anonymous.push(group[0])
      }
    }
  }
  for (const r of anonymous) {
    items.push({ ts: when(r), kind: 'single', key: (r as { runId?: string }).runId ?? when(r), rows: [r] })
  }
  items.sort((a, b) => b.ts.localeCompare(a.ts))

  const blocks: Block<T>[] = []
  for (const item of items) {
    const last = blocks[blocks.length - 1]
    if (item.kind === 'single' && last && last.kind === 'singles') {
      last.rows.push(item.rows[0])
      continue
    }
    blocks.push(
      item.kind === 'batch'
        ? { kind: 'batch', key: item.key, rows: item.rows }
        : { kind: 'singles', key: item.key, rows: [...item.rows] },
    )
  }
  return blocks
}

/** One batch, boxed, with a header naming who requested it and when, and a copy button that yields
 * one line per deployment -- which is exactly the Teams update the team sends when a batch goes out.
 * The button copies the whole batch in one click; the alternative was clicking Copy on each row. */
export function BatchGroup<T extends Groupable>({
  rows,
  children,
}: {
  rows: T[]
  children: ReactNode
}) {
  const first = rows[0]
  const envs = [...new Set(rows.map((r) => r.env ?? '').filter(Boolean))]
  const who = first.requestedBy && first.requestedBy !== '-------' ? first.requestedBy : null

  return (
    <section className={styles.group}>
      <header className={styles.header}>
        <span className={styles.count}>
          {rows.length} deployments {who ? `by ${who}` : 'requested together'}
        </span>
        <span className={styles.meta}>
          {envs.join(' · ')}
          {first.startedAt ? ` · ${formatTimestamp(first.startedAt)}` : ''}
        </span>
        <span className={styles.spacer} />
        {/* Copies EVERY row in the batch, one line each, not just the finished ones.
            Originally it filtered to rows with an outcome, on the reasoning that a label promising
            "all 5" while pasting 2 lines would be a lie -- but that made the button vanish entirely
            for a batch that had only just been requested, which is exactly when the team wants to
            post "these four are going out now". Each line carries its OWN status word ("Deploying.",
            "Done.", "Failed."), so copying all of them is accurate rather than misleading. */}
        <CopyLinkButton
          items={rows.map((r) => itemForRun(r as unknown as MyDeploymentRow))}
          label={`Copy all ${rows.length}`}
        />
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  )
}
