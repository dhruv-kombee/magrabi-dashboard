import { Fragment, useMemo, useState } from 'react'
import type { KeyVaultEnv, SecretRow, ServiceRow } from '../api/types'
import { KeyRotationConfirm } from './KeyRotationConfirm'
import { KeyRotationVersions } from './KeyRotationVersions'
import styles from './KeyRotationRollback.module.css'

/** Roll the vault back to each secret's previous version and push that value out again.
 *
 * Owns its own selection, its own expansion state and its own confirmation; the page owns the
 * mutation and the result table. That split is on purpose -- the selection is a lot of state that
 * only matters here, while the result of a rollback has to render in exactly the same place, and
 * in exactly the same shape, as the result of a sync.
 *
 * Two things this is built to prevent, both of which are real failure modes of a mid-incident
 * rollback:
 *
 * 1. **Rolling back more than you meant to.** The whole point of the per-service checkboxes is
 *    that one bad service can be reverted without dragging the other nineteen back with it. So
 *    nothing is selected by default, "Select all" is an explicit click, and the confirmation names
 *    the services and counts the destinations rather than saying "selected services".
 * 2. **Rolling back to something worse.** A previous version can be an empty string or the
 *    `__SET_ME__` placeholder, and restoring that breaks the service more thoroughly than the
 *    credential you were trying to undo. The per-secret version list exists so the operator can
 *    see the length and hash of the target version BEFORE committing, not after.
 */
export function KeyRotationRollback({
  env,
  services,
  secrets,
  busy,
  onRun,
}: {
  env: KeyVaultEnv
  services: ServiceRow[]
  secrets: SecretRow[]
  busy: boolean
  onRun: (selected: string[], dryRun: boolean) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string[]>([])
  const [openVersions, setOpenVersions] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)

  /** What may actually be rolled back.
   *
   * Two exclusions, and the second one is the interesting one. A service with no earlier distinct
   * version has nothing to go back to. A BLOCKED service -- one holding a value this vault has
   * never held -- is excluded because pushing an older value at an unidentified destination is the
   * same mistake as syncing it, just in reverse.
   *
   * It is excluded PER SERVICE rather than disabling the whole section, which an earlier draft did.
   * One wrongly-mapped credential somewhere in the estate must not stop you reverting the service
   * that is actually on fire -- which is the entire reason the checkboxes exist. */
  const rollable = useMemo(
    () => services.filter((s) => s.canRollback && !s.blocked),
    [services],
  )
  const blockedServices = useMemo(() => services.filter((s) => s.blocked), [services])

  // Secrets grouped by service, so an expanded row does not re-scan all 65 every render.
  const secretsByService = useMemo(() => {
    const map = new Map<string, SecretRow[]>()
    for (const s of secrets) {
      const list = map.get(s.service)
      if (list) list.push(s)
      else map.set(s.service, [s])
    }
    return map
  }, [secrets])

  // What the confirmation has to state: which services, and how many destinations will actually be
  // written. Counted from the secrets that CAN roll back -- a service's total destination count
  // would overstate it whenever one of its secrets has no earlier version.
  const scope = useMemo(() => {
    const names = selected.filter((name) => rollable.some((s) => s.service === name))
    let destinations = 0
    let secretCount = 0
    for (const name of names) {
      for (const sec of secretsByService.get(name) ?? []) {
        if (!sec.canRollback) continue
        secretCount += 1
        destinations += sec.destinations.length
      }
    }
    return { names, destinations, secrets: secretCount }
  }, [selected, rollable, secretsByService])

  const toggle = (service: string) =>
    setSelected((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service],
    )

  const toggleExpanded = (service: string) =>
    setExpanded((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service],
    )

  const toggleVersions = (secret: string) =>
    setOpenVersions((prev) =>
      prev.includes(secret) ? prev.filter((s) => s !== secret) : [...prev, secret],
    )

  const nothingSelected = scope.names.length === 0

  return (
    <section className={styles.section} aria-labelledby="keyrotation-rollback-title">
      <div className={styles.head}>
        <h2 id="keyrotation-rollback-title" className={styles.title}>
          Roll back
        </h2>
        <p className={styles.lede}>
          Puts each selected service's secrets back to their previous Key Vault version, then pushes
          that value to the same pipeline destinations. All services at once, or only the ones you
          tick. A secret with no earlier distinct version is skipped rather than failed.
        </p>
      </div>

      {blockedServices.length > 0 && (
        <p className={styles.blocked} role="status">
          {blockedServices.length === 1 ? 'One service is' : `${blockedServices.length} services are`}{' '}
          held back from rollback —{' '}
          {blockedServices.map((s) => s.service).join(', ')} — because a pipeline there holds a value
          this vault has never held. Pushing an older value at a destination nobody has identified is
          the same mistake as syncing it. Every other service can still be rolled back.
        </p>
      )}

      <div className={styles.toolbar}>
        <span className={styles.count}>
          {nothingSelected
            ? 'Nothing selected'
            : `${scope.names.length} service${scope.names.length === 1 ? '' : 's'} · ${scope.secrets} secret${scope.secrets === 1 ? '' : 's'} · ${scope.destinations} destination${scope.destinations === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => setSelected(rollable.map((s) => s.service))}
          disabled={rollable.length === 0}
        >
          Select all ({rollable.length})
        </button>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => setSelected([])}
          disabled={nothingSelected}
        >
          Clear
        </button>
      </div>

      <div className={styles.listWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.pickCol}>
                Roll back
              </th>
              <th scope="col">Service</th>
              <th scope="col">Secrets</th>
              <th scope="col" className={styles.hideNarrow}>
                Destinations
              </th>
              <th scope="col">Can roll back</th>
              <th scope="col" className={styles.detailCol}>
                Versions
              </th>
            </tr>
          </thead>
          <tbody>
            {services.map((svc) => {
              const isOpen = expanded.includes(svc.service)
              const rows = secretsByService.get(svc.service) ?? []
              const checkboxId = `rollback-${svc.service}`
              return (
                // Fragment carries the key: a service is two sibling <tr>s (the row and its
                // expansion) and a table row cannot wrap them in anything else.
                <Fragment key={svc.service}>
                  <tr className={selected.includes(svc.service) ? styles.rowPicked : undefined}>
                    <td className={styles.pickCell}>
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={selected.includes(svc.service)}
                        onChange={() => toggle(svc.service)}
                        disabled={!svc.canRollback || svc.blocked}
                      />
                      {/* A real label, bound by id. The visible service name is in the next cell,
                          which a screen reader reaches separately, so the label carries the full
                          sentence rather than repeating the name on its own. */}
                      <label className={styles.srOnly} htmlFor={checkboxId}>
                        Roll back {svc.service}
                      </label>
                    </td>
                    <td className={styles.service}>{svc.service}</td>
                    <td className={styles.num}>{svc.secrets}</td>
                    <td className={`${styles.num} ${styles.hideNarrow}`}>{svc.destinations}</td>
                    <td className={styles.nowrap}>
                      {svc.canRollback ? (
                        <span className={styles.pillYes}>yes</span>
                      ) : (
                        <span className={styles.pillNo}>no earlier version</span>
                      )}
                      {/* A blocked service is one whose pipelines hold a value the vault has never
                          held. Rolling it back would push the vault's older value over something
                          unidentified, so it is called out on the row itself. */}
                      {svc.blocked && <span className={styles.pillBlocked}>mapping unconfirmed</span>}
                    </td>
                    <td className={styles.detailCol}>
                      <button
                        type="button"
                        className={styles.expandBtn}
                        aria-expanded={isOpen}
                        onClick={() => toggleExpanded(svc.service)}
                      >
                        {isOpen ? 'Hide secrets' : `Show ${rows.length} secret${rows.length === 1 ? '' : 's'}`}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className={styles.detailRow}>
                      <td />
                      <td colSpan={5}>
                        <ul className={styles.secretList}>
                          {rows.map((sec) => (
                            <li key={sec.name} className={styles.secretItem}>
                              <div className={styles.secretHead}>
                                <span className={styles.mono}>{sec.name}</span>
                                <span className={styles.secretMeta}>
                                  {sec.destinations.length} destination
                                  {sec.destinations.length === 1 ? '' : 's'} · {sec.versionCount}{' '}
                                  version{sec.versionCount === 1 ? '' : 's'}
                                  {/* Current hash and the one a rollback goes back to, at a
                                      glance, so the common case needs no expansion at all. Both
                                      are 10-character SHA-256 prefixes, never a value. */}
                                  {sec.vaultHash && (
                                    <span className={styles.hashPair}>
                                      now <span className={styles.mono}>{sec.vaultHash}</span>
                                      {sec.previousHash && (
                                        <>
                                          , rolls back to{' '}
                                          <span className={styles.mono}>{sec.previousHash}</span>
                                        </>
                                      )}
                                    </span>
                                  )}
                                  {sec.vaultState === 'placeholder' && (
                                    <span className={styles.pillBlocked}>placeholder in vault</span>
                                  )}
                                  {!sec.canRollback && (
                                    <span className={styles.pillNo}>cannot roll back</span>
                                  )}
                                </span>
                                <button
                                  type="button"
                                  className={styles.expandBtn}
                                  aria-expanded={openVersions.includes(sec.name)}
                                  onClick={() => toggleVersions(sec.name)}
                                >
                                  {openVersions.includes(sec.name)
                                    ? 'Hide versions'
                                    : 'Show versions'}
                                </button>
                              </div>
                              {/* Mounted only while open, which is also what defers the Key Vault
                                  read -- see KeyRotationVersions. */}
                              {openVersions.includes(sec.name) && (
                                <KeyRotationVersions env={env} secret={sec.name} />
                              )}
                            </li>
                          ))}
                          {rows.length === 0 && (
                            <li className={styles.secretMeta}>
                              No secrets are mapped to this service.
                            </li>
                          )}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {services.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  No services were found in this environment's plan.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.actions}>
        {/* Preview writes nothing, so it does not get a confirmation -- a dialog in front of a
            read-only rehearsal only teaches people to click through dialogs. */}
        <button
          type="button"
          className={styles.previewBtn}
          disabled={nothingSelected || busy}
          onClick={() => onRun(scope.names, true)}
        >
          Preview rollback
        </button>
        <button
          type="button"
          className={styles.dangerBtn}
          disabled={nothingSelected || busy}
          onClick={() => setConfirming(true)}
        >
          {busy ? 'Rolling back…' : 'Roll back selected'}
        </button>
      </div>

      {confirming && (
        <KeyRotationConfirm
          title={`Roll back ${scope.names.length} service${scope.names.length === 1 ? '' : 's'} on ${env.toUpperCase()}?`}
          confirmLabel={`Roll back ${scope.destinations} destination${scope.destinations === 1 ? '' : 's'}`}
          danger
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            onRun(scope.names, false)
          }}
        >
          <p className={styles.confirmLead}>
            Each secret below goes back to its previous Key Vault version, and that value is then
            written to <strong>{scope.destinations}</strong> pipeline destination
            {scope.destinations === 1 ? '' : 's'} across <strong>{scope.secrets}</strong> secret
            {scope.secrets === 1 ? '' : 's'}.
          </p>
          <ul className={styles.confirmList}>
            {scope.names.map((name) => {
              const rows = (secretsByService.get(name) ?? []).filter((s) => s.canRollback)
              const dests = rows.reduce((n, s) => n + s.destinations.length, 0)
              return (
                <li key={name}>
                  <strong>{name}</strong> — {rows.length} secret{rows.length === 1 ? '' : 's'},{' '}
                  {dests} destination{dests === 1 ? '' : 's'}
                </li>
              )
            })}
          </ul>
        </KeyRotationConfirm>
      )}
    </section>
  )
}
