import { useState } from 'react'
import { useNewDeploymentMutation } from '../api/hooks'
import styles from './NewDeploymentForm.module.css'

export function NewDeploymentForm() {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const mutation = useNewDeploymentMutation()

  function handleSubmit() {
    if (!text.trim()) return
    // Left blank -> backend records "Random" -- this is just an audit-trail label, never sent to
    // ADO, so there's no harm in defaulting it rather than forcing the field.
    mutation.mutate(
      { text, name: name.trim() },
      {
        onSuccess: (data) => {
          if (data.ok) setText('')
        },
      },
    )
  }

  return (
    <div className={styles.box}>
      <p className={styles.hint}>
        Paste a deployment request — plain English works (e.g. "deploy drm sanity on release/sit in
        sit env"), or the labeled Teams format: "Please deploy ENV: SIT Pipeline: Ecom-Tabby Branch:
        tabby-app/sit"
      </p>
      <textarea
        className={styles.textarea}
        rows={3}
        placeholder="Paste the request text here…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <br />
      <div className={styles.submitRow}>
        <button className={styles.submit} onClick={handleSubmit} disabled={mutation.isPending}>
          {mutation.isPending ? 'Starting…' : 'Start Deployment'}
        </button>
        <input
          className={styles.nameInput}
          type="text"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {mutation.data && (
        <p className={`${styles.result} ${mutation.data.ok ? styles.ok : styles.err}`}>{mutation.data.message}</p>
      )}
      {mutation.isError && <p className={`${styles.result} ${styles.err}`}>{(mutation.error as Error).message}</p>}
    </div>
  )
}
