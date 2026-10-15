import { useMemo, useState } from 'react'
import { useEnvVarsQuery } from '../api/hooks'
import styles from './EnvVarsModal.module.css'

/** Read-only view of the variables configured for one pipeline stage.
 *
 * Secret handling is the whole design constraint here. These release definitions carry real
 * credentials in plaintext inside their Docker buildArguments -- Sanity tokens, the AD B2C client
 * secret, a SendGrid key, the Sentry auth token and more -- so the backend drops the value of
 * anything whose name looks like a credential before it is ever serialized. This component only
 * ever receives null for those, and renders the NAME so people can see the variable exists and go
 * read its value in ADO if they are entitled to.
 */
export function EnvVarsModal({
  pipeline,
  env,
  onClose,
}: {
  pipeline: string
  env: string
  onClose: () => void
}) {
  const { data, isLoading, isError, error } = useEnvVarsQuery(pipeline, env)
  const [search, setSearch] = useState('')
  const [hideSecrets, setHideSecrets] = useState(false)

  const entries = useMemo(() => {
    const all = data?.entries ?? []
    const needle = search.trim().toLowerCase()
    return all.filter((e) => {
      if (hideSecrets && e.isSecret) return false
      if (!needle) return true
      return (
        e.name.toLowerCase().includes(needle) ||
        (e.value ?? '').toLowerCase().includes(needle) ||
        e.source.toLowerCase().includes(needle)
      )
    })
  }, [data, search, hideSecrets])

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Environment variables for ${pipeline} ${env}`}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>
              {pipeline} <span className={styles.env}>{env}</span>
            </h2>
            {data && (
              <p className={styles.subtitle}>
                {data.definitionName} → stage “{data.stageName}” · {data.project}
                {data.variableGroups.length > 0 && ` · groups: ${data.variableGroups.join(', ')}`}
              </p>
            )}
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className={styles.controls}>
          <input
            className={styles.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name, value or source…"
          />
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={hideSecrets}
              onChange={(e) => setHideSecrets(e.target.checked)}
            />
            Hide secrets
          </label>
        </div>

        {isLoading && <p className={styles.state}>Loading…</p>}
        {isError && <p className={styles.error}>{(error as Error).message}</p>}

        {data && (
          <>
            <p className={styles.summary}>
              {data.entries.length} variables · <strong>{data.secretCount} masked</strong> as
              credentials
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={`${e.name}-${e.source}-${i}`}>
                      <td className={styles.name}>{e.name}</td>
                      <td>
                        {e.value === null ? (
                          <span className={styles.withheld} title="Value not available on this screen">
                            not shown
                          </span>
                        ) : (
                          // Same coding as the Variables page: green for ordinary settings, red for
                          // credentials. value === null is the backend REFUSING to send it, which is
                          // a different fact from an empty string and must not render the same.
                          <span
                            className={`${styles.value} ${e.isSecret ? styles.valSecret : styles.valPlain}`}
                          >
                            {e.value === '' ? <em>(empty)</em> : e.value}
                          </span>
                        )}
                      </td>
                      <td className={styles.source}>{e.source}</td>
                    </tr>
                  ))}
                  {entries.length === 0 && (
                    <tr>
                      <td colSpan={3} className={styles.state}>
                        Nothing matches that filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
