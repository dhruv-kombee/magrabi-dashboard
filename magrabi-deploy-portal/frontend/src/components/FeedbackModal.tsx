import { useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { FeedbackType } from '../api/types'
import { useSubmitFeedbackMutation } from '../api/hooks'
import styles from './FeedbackModal.module.css'

const MAX_TITLE = 200
const MAX_DESCRIPTION = 5000

/** 3 MB. Checked here purely to fail fast with a readable message -- the backend enforces its own
 * limit independently, and a client-side check is advisory, never a boundary. */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024

/** The `accept` attribute is only a file-picker filter -- it is trivially bypassed by dragging a
 * file in or by a picker that ignores it -- so the same list is re-checked against the File's
 * reported MIME type on selection. */
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

const TYPE_OPTIONS: { value: FeedbackType; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'suggestion', label: 'Suggestion' },
]

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface FeedbackModalProps {
  onClose: () => void
}

export function FeedbackModal({ onClose }: FeedbackModalProps) {
  const [type, setType] = useState<FeedbackType>('improvement')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [link, setLink] = useState('')
  /** Gates the link error so it appears on blur or submit, not on the "h" of "https". */
  const [linkTouched, setLinkTouched] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  /** Separate from the mutation's own error: a 200 response can still carry {ok: false, message}. */
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const mutation = useSubmitFeedbackMutation()

  const trimmedLink = link.trim()
  const linkInvalid = trimmedLink !== '' && !/^https?:\/\//i.test(trimmedLink)
  const showLinkError = linkInvalid && linkTouched

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // The object URL is owned by this effect, not by the change handler: returning the revoke from
  // here is what guarantees it runs on BOTH paths -- picking a different file and unmounting the
  // modal -- so a blob can never outlive the preview that used it.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // Brief confirmation, then dismiss. onClose is stable (FeedbackButton memoizes it), so this
  // fires once rather than restarting on every parent render.
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(onClose, 1200)
    return () => window.clearTimeout(timer)
  }, [done, onClose])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null
    setFileError(null)
    if (!picked) {
      setFile(null)
      return
    }
    // Both rejection paths clear the input's value as well as the state. Without that the picker
    // holds onto the rejected file and re-choosing the SAME file fires no change event, leaving
    // the user unable to retry after fixing nothing.
    if (!ACCEPTED_IMAGE_TYPES.includes(picked.type)) {
      setFileError('Only PNG, JPEG, GIF and WebP images can be attached.')
      setFile(null)
      e.target.value = ''
      return
    }
    if (picked.size > MAX_ATTACHMENT_BYTES) {
      setFileError(`That image is ${megabytes(picked.size)}. The limit is 3 MB -- please attach a smaller one.`)
      setFile(null)
      e.target.value = ''
      return
    }
    setFile(picked)
  }

  function clearFile() {
    setFile(null)
    setFileError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleOverlayClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  const requiredFilled = title.trim() !== '' && description.trim() !== ''
  const canSubmit = requiredFilled && !linkInvalid && !mutation.isPending && !done

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (linkInvalid) {
      setLinkTouched(true)
      return
    }
    if (!canSubmit) return
    setSubmitError(null)
    mutation.mutate(
      { type, title: title.trim(), description: description.trim(), link: trimmedLink, attachment: file },
      {
        onSuccess: (data) => {
          if (data.ok) setDone(true)
          else setSubmitError(data.message ?? 'The request could not be saved.')
        },
        onError: (err: unknown) => {
          setSubmitError(err instanceof Error ? err.message : 'The request could not be saved.')
        },
      },
    )
  }

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={`${fieldId}-heading`}>
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>Feedback</span>
            <h2 className={styles.heading} id={`${fieldId}-heading`}>
              Raise a request
            </h2>
            <span className={styles.subtitle}>
              Report a bug, ask for an improvement, or suggest something new for the portal.
            </span>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close feedback form">
            <svg viewBox="0 0 24 24" className={styles.closeIcon} aria-hidden="true">
              <path d="M6 6 18 18" />
              <path d="M18 6 6 18" />
            </svg>
          </button>
        </header>

        {done ? (
          <div className={styles.success} role="status">
            <svg viewBox="0 0 24 24" className={styles.successIcon} aria-hidden="true">
              <path d="m5 13 4 4 10-10" />
            </svg>
            <strong className={styles.successTitle}>Request submitted</strong>
            <span className={styles.successText}>Thanks -- the team can see it in the feedback inbox.</span>
          </div>
        ) : (
          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            <div className={styles.field}>
              <span className={styles.label} id={`${fieldId}-type-label`}>
                Type
              </span>
              <div className={styles.typeRow} role="radiogroup" aria-labelledby={`${fieldId}-type-label`}>
                {TYPE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`${styles.typeChip} ${type === option.value ? styles.typeChipActive : ''}`}
                  >
                    <input
                      type="radio"
                      name={`${fieldId}-type`}
                      className={styles.typeRadio}
                      value={option.value}
                      checked={type === option.value}
                      onChange={() => setType(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldId}-title`}>
                Title <span className={styles.required}>required</span>
              </label>
              <input
                ref={titleRef}
                id={`${fieldId}-title`}
                className={styles.input}
                type="text"
                maxLength={MAX_TITLE}
                placeholder="Short summary of the request"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldId}-description`}>
                Description <span className={styles.required}>required</span>
              </label>
              <textarea
                id={`${fieldId}-description`}
                className={styles.textarea}
                rows={5}
                maxLength={MAX_DESCRIPTION}
                placeholder="What happened, what you expected, and how to reproduce it."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <span
                className={`${styles.counter} ${description.length > MAX_DESCRIPTION - 200 ? styles.counterWarn : ''}`}
              >
                {description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldId}-link`}>
                Link <span className={styles.optional}>optional</span>
              </label>
              <input
                id={`${fieldId}-link`}
                className={`${styles.input} ${showLinkError ? styles.inputError : ''}`}
                type="url"
                inputMode="url"
                placeholder="https://..."
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onBlur={() => setLinkTouched(true)}
                aria-invalid={showLinkError}
              />
              {showLinkError && (
                <span className={styles.fieldError}>The link must start with http:// or https://</span>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldId}-attachment`}>
                Screenshot <span className={styles.optional}>optional</span>
              </label>
              <input
                ref={fileInputRef}
                id={`${fieldId}-attachment`}
                className={styles.fileInput}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(',')}
                onChange={handleFileChange}
              />
              {fileError && <span className={styles.fieldError}>{fileError}</span>}
              {file && previewUrl && (
                <div className={styles.preview}>
                  <img className={styles.thumb} src={previewUrl} alt="Selected attachment preview" />
                  <div className={styles.previewMeta}>
                    <span className={styles.previewName}>{file.name}</span>
                    <span className={styles.previewSize}>{megabytes(file.size)}</span>
                  </div>
                  <button type="button" className={styles.clearFile} onClick={clearFile}>
                    Remove
                  </button>
                </div>
              )}
            </div>

            {submitError && (
              <div className={styles.formError} role="alert">
                <strong className={styles.formErrorTitle}>Could not submit</strong>
                <span className={styles.formErrorText}>{submitError}</span>
              </div>
            )}

            <div className={styles.footer}>
              <button type="button" className={styles.cancel} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className={styles.submit} disabled={!canSubmit}>
                {mutation.isPending ? 'Submitting…' : 'Submit request'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
