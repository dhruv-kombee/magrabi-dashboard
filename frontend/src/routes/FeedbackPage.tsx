import { useEffect, useMemo, useState } from 'react'
import type { FeedbackItem, FeedbackStatus, FeedbackType } from '../api/types'
import { useDeleteFeedbackMutation, useFeedbackQuery, useUpdateFeedbackMutation } from '../api/hooks'
import { feedbackAttachmentUrl } from '../api/client'
import { formatTimestamp } from '../utils/format'
import pageStyles from './Page.module.css'
import styles from './FeedbackPage.module.css'

const STATUS_ORDER: FeedbackStatus[] = ['new', 'planned', 'done', 'dismissed']
const TYPE_ORDER: FeedbackType[] = ['bug', 'improvement', 'suggestion']

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: 'New',
  planned: 'Planned',
  done: 'Done',
  dismissed: 'Dismissed',
}

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: 'Bug',
  improvement: 'Improvement',
  suggestion: 'Suggestion',
}

const STATUS_CLASS: Record<FeedbackStatus, string> = {
  new: styles.statusNew,
  planned: styles.statusPlanned,
  done: styles.statusDone,
  dismissed: styles.statusDismissed,
}

const TYPE_CLASS: Record<FeedbackType, string> = {
  bug: styles.typeBug,
  improvement: styles.typeImprovement,
  suggestion: styles.typeSuggestion,
}

/** How long the delete button stays armed before reverting to its safe label. */
const DELETE_ARM_MS = 4000

export function FeedbackPage() {
  // Always enabled: this page only ever mounts behind RequireRole allow={['admin']}, so the
  // viewer-403 case the hook's `enabled` flag guards against cannot happen here.
  const { data, isLoading, isError, error } = useFeedbackQuery(true)
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | 'all'>('all')
  const [typeFilter, setTypeFilter] = useState<FeedbackType | 'all'>('all')
  const [search, setSearch] = useState('')

  const items = useMemo(() => data?.items ?? [], [data])
  const counts = data?.counts

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return items
      .filter((item) => statusFilter === 'all' || item.status === statusFilter)
      .filter((item) => typeFilter === 'all' || item.type === typeFilter)
      .filter(
        (item) =>
          !needle ||
          `${item.title} ${item.description} ${item.submittedBy}`.toLowerCase().includes(needle),
      )
      // The API already sorts newest-first, so this is belt-and-braces -- but it costs nothing and
      // it means the order is a property of this view rather than a trusted remote detail.
      // submittedAt is ISO 8601 UTC, which sorts correctly as a plain string; no Date parsing.
      .slice()
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  }, [items, statusFilter, typeFilter, search])

  const filtersActive = statusFilter !== 'all' || typeFilter !== 'all' || search.trim() !== ''

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.pageHead}>
        <div>
          <h1 className={pageStyles.pageTitle}>Feedback</h1>
          <p className={pageStyles.pageSubtitle}>
            Everything raised from the portal, newest first. Only admins can see this inbox.
          </p>
        </div>
      </div>

      {/* Summary and status filter in one control. Two separate widgets driving the same state
          would leave the reader guessing whether the counts respect the filter -- here the
          selected tile IS the filter, so there is nothing to reconcile. */}
      <div className={styles.counts}>
        <button
          type="button"
          className={`${styles.countTile} ${statusFilter === 'all' ? styles.countTileActive : ''}`}
          onClick={() => setStatusFilter('all')}
          aria-pressed={statusFilter === 'all'}
        >
          <span className={styles.countValue}>{counts?.total ?? 0}</span>
          <span className={styles.countLabel}>Total</span>
        </button>
        {STATUS_ORDER.map((status) => (
          <button
            key={status}
            type="button"
            className={`${styles.countTile} ${statusFilter === status ? styles.countTileActive : ''}`}
            onClick={() => setStatusFilter(status)}
            aria-pressed={statusFilter === status}
          >
            <span className={`${styles.countValue} ${STATUS_CLASS[status]}`}>
              {counts?.[status] ?? 0}
            </span>
            <span className={styles.countLabel}>{STATUS_LABELS[status]}</span>
          </button>
        ))}
      </div>

      <div className={styles.filterBar}>
        <div className={styles.searchWrap}>
          <input
            className={styles.searchInput}
            type="search"
            placeholder="Search title, description or submitter..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search feedback"
          />
        </div>
        <div className={styles.field}>
          <label className={styles.filterLabel} htmlFor="feedback-status-filter">
            Status
          </label>
          <select
            id="feedback-status-filter"
            className={styles.select}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as FeedbackStatus | 'all')}
          >
            <option value="all">All statuses</option>
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.filterLabel} htmlFor="feedback-type-filter">
            Type
          </label>
          <select
            id="feedback-type-filter"
            className={styles.select}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as FeedbackType | 'all')}
          >
            <option value="all">All types</option>
            {TYPE_ORDER.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={styles.clearAll}
          onClick={() => {
            setStatusFilter('all')
            setTypeFilter('all')
            setSearch('')
          }}
          disabled={!filtersActive}
        >
          Clear filters
        </button>
      </div>

      {isLoading && <p className={pageStyles.loading}>Loading feedback…</p>}
      {isError && <p className={pageStyles.error}>{(error as Error).message}</p>}

      {!isLoading && !isError && items.length === 0 && (
        <p className={pageStyles.empty}>No feedback yet.</p>
      )}

      {!isLoading && !isError && items.length > 0 && visible.length === 0 && (
        <p className={pageStyles.empty}>No requests match these filters.</p>
      )}

      {visible.length > 0 && (
        <>
          <p className={pageStyles.updated}>
            Showing {visible.length} of {items.length}
          </p>
          <ul className={styles.list}>
            {visible.map((item) => (
              <FeedbackCard key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </main>
  )
}

function FeedbackCard({ item }: { item: FeedbackItem }) {
  const update = useUpdateFeedbackMutation()
  const remove = useDeleteFeedbackMutation()
  const [note, setNote] = useState(item.adminNote)
  const [noteBaseline, setNoteBaseline] = useState(item.adminNote)
  const [armed, setArmed] = useState(false)

  // Re-seed the textarea when the server's value actually changes -- a save landing, or a refetch
  // picking up another admin's edit. Comparing against a baseline rather than assigning on every
  // render is what keeps this from wiping out the note the user is mid-way through typing.
  if (item.adminNote !== noteBaseline) {
    setNoteBaseline(item.adminNote)
    setNote(item.adminNote)
  }

  // Auto-disarm, so a delete armed and then forgotten cannot be completed by a stray click minutes
  // later. Returning the clear also covers unmount -- this card disappears the moment its own
  // delete succeeds, and a timer left running would set state on a gone component.
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), DELETE_ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  const noteDirty = note !== item.adminNote
  const busy = update.isPending || remove.isPending

  function handleDelete() {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    remove.mutate({ id: item.id })
  }

  const mutationError = update.isError
    ? (update.error as Error).message
    : remove.isError
      ? (remove.error as Error).message
      : null

  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <span className={`${styles.badge} ${TYPE_CLASS[item.type]}`}>{TYPE_LABELS[item.type]}</span>
        <span className={`${styles.badge} ${styles.badgeFilled} ${STATUS_CLASS[item.status]}`}>
          {STATUS_LABELS[item.status]}
        </span>
        <span className={styles.meta}>
          {item.submittedBy}
          <span className={styles.metaRole}>{item.submittedByRole}</span>
        </span>
        <time className={styles.timestamp} dateTime={item.submittedAt}>
          {formatTimestamp(item.submittedAt)}
        </time>
      </div>

      <h2 className={styles.cardTitle}>{item.title}</h2>
      <p className={styles.description}>{item.description}</p>

      {(item.link || item.attachment) && (
        <div className={styles.attachments}>
          {item.link && (
            <a className={styles.link} href={item.link} target="_blank" rel="noreferrer">
              {item.link}
            </a>
          )}
          {item.attachment && (
            <a
              className={styles.thumbLink}
              href={feedbackAttachmentUrl(item.id)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                className={styles.thumb}
                src={feedbackAttachmentUrl(item.id)}
                alt={`Attachment for "${item.title}"`}
                loading="lazy"
              />
            </a>
          )}
        </div>
      )}

      <div className={styles.controls}>
        <div className={styles.controlField}>
          <label className={styles.controlLabel} htmlFor={`status-${item.id}`}>
            Status
          </label>
          <select
            id={`status-${item.id}`}
            className={styles.select}
            value={item.status}
            disabled={busy}
            onChange={(e) => update.mutate({ id: item.id, status: e.target.value as FeedbackStatus })}
          >
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.noteField}>
          <label className={styles.controlLabel} htmlFor={`note-${item.id}`}>
            Admin note
          </label>
          <textarea
            id={`note-${item.id}`}
            className={styles.noteInput}
            rows={2}
            placeholder="Internal note -- not shown to the submitter."
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className={styles.controlActions}>
          {/* Explicit save rather than an onChange PATCH: a note is typed a character at a time and
              firing a write per keystroke would hammer the backend with dozens of partial notes. */}
          <button
            type="button"
            className={styles.save}
            onClick={() => update.mutate({ id: item.id, adminNote: note })}
            disabled={!noteDirty || busy}
          >
            {update.isPending ? 'Saving…' : noteDirty ? 'Save note' : 'Saved'}
          </button>
          <button
            type="button"
            className={`${styles.delete} ${armed ? styles.deleteArmed : ''}`}
            onClick={handleDelete}
            disabled={busy}
          >
            {remove.isPending ? 'Deleting…' : armed ? 'Confirm delete' : 'Delete'}
          </button>
        </div>
      </div>

      {mutationError && <p className={styles.cardError}>{mutationError}</p>}
    </li>
  )
}
