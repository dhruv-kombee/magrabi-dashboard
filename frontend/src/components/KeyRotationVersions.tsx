import { useMemo } from 'react'
import { useKeyVaultVersionsQuery } from '../api/hooks'
import type { KeyVaultEnv } from '../api/types'
import { formatTimestamp } from '../utils/format'
import styles from './KeyRotationVersions.module.css'

/** Every stored version of one Key Vault secret, newest first, with the one a rollback would
 * restore marked.
 *
 * Fetched only when the row is expanded -- 65 secrets would otherwise be 65 Key Vault reads on page
 * load, for information almost nobody looks at. The query key is env+secret, so expanding the same
 * row twice reuses the cache.
 *
 * A version carries a 10-character SHA-256 prefix, a character length and a version id. Not a
 * value. The point of showing it is so an operator can see WHAT a rollback would go back to -- that
 * the previous version is a real, different, 191-character value and not an empty string or the
 * `__SET_ME__` placeholder -- without the value itself ever leaving the vault.
 */
export function KeyRotationVersions({ env, secret }: { env: KeyVaultEnv; secret: string }) {
  const { data, isLoading, isError, error } = useKeyVaultVersionsQuery(env, secret)

  // The rollback target is the newest version whose hash DIFFERS from the current one, which is not
  // necessarily the second row: a rotation that was pushed twice leaves two versions holding the
  // same value, and restoring one of those would be a no-op dressed up as a rollback.
  const targetVersionId = useMemo(() => {
    const versions = data?.versions ?? []
    const current = versions.find((v) => v.current)
    if (!current) return null
    const target = versions.find((v) => !v.current && v.hash !== current.hash)
    return target?.versionId ?? null
  }, [data])

  if (isLoading) return <p className={styles.state}>Reading versions…</p>
  if (isError) {
    return <p className={styles.stateBad}>Could not read versions: {(error as Error).message}</p>
  }

  const versions = data?.versions ?? []
  if (versions.length === 0) {
    return <p className={styles.state}>This secret has no stored versions.</p>
  }

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className={styles.caption}>
          Stored versions of <span className={styles.mono}>{secret}</span>, newest first.
          {targetVersionId
            ? ' A rollback restores the row marked “rolls back to”.'
            : ' There is no earlier distinct version, so this secret cannot roll back.'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Created</th>
            <th scope="col">Hash</th>
            <th scope="col">Length</th>
            <th scope="col">Version</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr
              key={v.versionId}
              className={
                v.current
                  ? styles.rowCurrent
                  : v.versionId === targetVersionId
                    ? styles.rowTarget
                    : undefined
              }
            >
              <td className={styles.nowrap}>{formatTimestamp(v.created)}</td>
              <td className={styles.mono}>{v.hash ?? '—'}</td>
              <td className={styles.num}>{v.length ?? '—'}</td>
              <td className={`${styles.mono} ${styles.versionId}`}>{v.versionId}</td>
              <td className={styles.nowrap}>
                {v.current && <span className={styles.pillCurrent}>in the vault now</span>}
                {!v.current && v.versionId === targetVersionId && (
                  <span className={styles.pillTarget}>rolls back to</span>
                )}
                {!v.enabled && <span className={styles.pillOff}>disabled</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
