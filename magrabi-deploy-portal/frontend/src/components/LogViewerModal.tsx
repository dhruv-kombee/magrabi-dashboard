import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { fetchTaskLog, taskLogUrl } from '../api/client'
import styles from './LogViewerModal.module.css'

/** Azure DevOps task logs run to hundreds of thousands of lines on a bad build. Rendering one row
 * per line past this point freezes the tab for seconds, so we render the tail only -- the tail is
 * also the part anyone opening a log actually wants -- and point at the download for the rest. */
const MAX_RENDERED_LINES = 5000

interface LogLine {
  n: number
  text: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(line: string, needle: string): ReactNode {
  if (!needle) return line
  // The capture group makes split() interleave matches at the odd indices, so the parts array
  // alternates plain/match/plain without a second pass to find offsets.
  const parts = line.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'))
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className={styles.match}>
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

interface LogViewerModalProps {
  releaseId: number
  rawEnv: string
  pipeline: string
  phaseId: number
  taskId: number
  taskName: string
  onClose: () => void
}

export function LogViewerModal({
  releaseId,
  rawEnv,
  pipeline,
  phaseId,
  taskId,
  taskName,
  onClose,
}: LogViewerModalProps) {
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** Kept separate from `error`: a failed copy must not blank out a log that loaded perfectly. */
  const [copyNote, setCopyNote] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setText(null)
    fetchTaskLog(releaseId, rawEnv, pipeline, phaseId, taskId)
      .then((body) => {
        if (cancelled) return
        setText(body)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load this log.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [releaseId, rawEnv, pipeline, phaseId, taskId])

  useEffect(() => {
    // The drawer underneath also listens for Escape on window. stopPropagation would not help --
    // it does not suppress sibling listeners on the same target -- so the drawer instead ignores
    // Escape entirely while this modal is mounted, and only this handler acts on it.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    // Searching is the first thing anyone does in a failed step's log.
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!copyNote) return
    const timer = window.setTimeout(() => setCopyNote(null), 2200)
    return () => window.clearTimeout(timer)
  }, [copyNote])

  const allLines = useMemo<LogLine[]>(() => {
    if (text === null) return []
    const split = text.replace(/\r\n/g, '\n').split('\n')
    // A trailing newline leaves an empty final element; dropping it avoids a phantom last line
    // number in the gutter.
    if (split.length > 1 && split[split.length - 1] === '') split.pop()
    return split.map((value, i) => ({ n: i + 1, text: value }))
  }, [text])

  const truncated = allLines.length > MAX_RENDERED_LINES
  const windowed = useMemo(
    () => (allLines.length > MAX_RENDERED_LINES ? allLines.slice(-MAX_RENDERED_LINES) : allLines),
    [allLines],
  )

  const needle = query.trim()
  const visible = useMemo(() => {
    if (!needle) return windowed
    const lower = needle.toLowerCase()
    return windowed.filter((line) => line.text.toLowerCase().includes(lower))
  }, [windowed, needle])

  const downloadUrl = taskLogUrl(releaseId, rawEnv, pipeline, phaseId, taskId)
  const fileName = `${taskName.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'task'}.log`

  async function handleCopy() {
    const full = text ?? ''
    // navigator.clipboard is undefined outside secure contexts; the portal is reachable over
    // plain HTTP internally, so the legacy path is a real code path here, not paranoia.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(full)
        setCopyNote('Copied')
        return
      }
    } catch {
      /* fall through to the textarea approach below */
    }
    const scratch = document.createElement('textarea')
    scratch.value = full
    scratch.setAttribute('readonly', '')
    scratch.style.position = 'fixed'
    scratch.style.opacity = '0'
    document.body.appendChild(scratch)
    scratch.select()
    try {
      document.execCommand('copy')
      setCopyNote('Copied')
    } catch {
      setCopyNote('Copy unavailable')
    }
    document.body.removeChild(scratch)
  }

  function handleOverlayClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="log-viewer-title">
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>Task log</span>
            <h3 className={styles.title} id="log-viewer-title">
              {taskName}
            </h3>
            <span className={styles.subtitle}>
              {pipeline} · {rawEnv} · release {releaseId}
            </span>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close log viewer">
            <svg viewBox="0 0 24 24" className={styles.closeIcon} aria-hidden="true">
              <path d="M6 6 18 18" />
              <path d="M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className={styles.toolbar}>
          <input
            ref={searchRef}
            className={styles.search}
            type="search"
            placeholder="Filter lines..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={loading || text === null}
          />
          <span className={styles.counts}>
            {needle
              ? `${visible.length} matching ${visible.length === 1 ? 'line' : 'lines'}`
              : `${allLines.length} ${allLines.length === 1 ? 'line' : 'lines'}`}
          </span>
          <div className={styles.toolbarActions}>
            <button type="button" className={styles.action} onClick={handleCopy} disabled={text === null}>
              {copyNote ?? 'Copy'}
            </button>
            <a className={styles.action} href={downloadUrl} download={fileName}>
              Download
            </a>
          </div>
        </div>

        {truncated && (
          <p className={styles.notice}>
            Showing the last {MAX_RENDERED_LINES.toLocaleString()} lines of{' '}
            {allLines.length.toLocaleString()}.{' '}
            <a className={styles.noticeLink} href={downloadUrl} download={fileName}>
              Download the full log
            </a>{' '}
            to see everything.
          </p>
        )}

        <div className={styles.body}>
          {loading && <p className={styles.state}>Loading log from Azure DevOps...</p>}

          {!loading && error && (
            <div className={styles.errorBox}>
              <strong className={styles.errorTitle}>Could not load this log</strong>
              <span className={styles.errorMessage}>{error}</span>
            </div>
          )}

          {!loading && !error && allLines.length === 0 && (
            <p className={styles.state}>This step produced no log output.</p>
          )}

          {!loading && !error && allLines.length > 0 && visible.length === 0 && (
            <p className={styles.state}>No lines match &ldquo;{needle}&rdquo;.</p>
          )}

          {!loading && !error && visible.length > 0 && (
            <div className={styles.lines}>
              {visible.map((line) => (
                <div className={styles.line} key={line.n}>
                  <span className={styles.lineNo}>{line.n}</span>
                  <span className={styles.lineText}>{highlight(line.text, needle)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
