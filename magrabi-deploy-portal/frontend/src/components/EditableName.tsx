import { useEffect, useRef, useState } from 'react'
import { useDeploymentNameMutation } from '../api/hooks'
import styles from './EditableName.module.css'

const PLACEHOLDER = '-------'

/** The Name cell, editable in place.
 *
 * Name used to be capture-once, typed next to Start Deployment. Nobody knows to fill it in at that
 * moment -- a row becomes worth attributing when someone asks about it later -- so in practice
 * every row read "-------" forever. Click the cell to set or change it at any time, on a running or
 * a long-finished deployment alike.
 */
export function EditableName({ runId, value }: { runId: string; value: string | null }) {
  const current = value && value !== PLACEHOLDER ? value : ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(current)
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const save = useDeploymentNameMutation()

  // Re-sync when the row refreshes underneath us, but never while the user is mid-edit -- that
  // would yank characters out from under them on a 2s poll.
  useEffect(() => {
    if (!editing) setDraft(current)
  }, [current, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next === current) return
    setError(false)
    save.mutate(
      { runId, name: next },
      {
        onError: () => {
          setError(true)
          setDraft(current)
        },
      },
    )
  }

  if (!editing) {
    return (
      <button
        className={`${styles.display} ${error ? styles.error : ''}`}
        onClick={() => setEditing(true)}
        title={error ? 'Could not save -- click to try again' : 'Click to set a name'}
      >
        {current || <span className={styles.placeholder}>{PLACEHOLDER}</span>}
      </button>
    )
  }

  return (
    <input
      ref={inputRef}
      className={styles.input}
      value={draft}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        // Escape abandons the edit rather than saving a half-typed name.
        if (e.key === 'Escape') {
          setDraft(current)
          setEditing(false)
        }
      }}
      placeholder="name"
    />
  )
}
