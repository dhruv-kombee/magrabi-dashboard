export function markSnapshotStale<T extends object>(snapshot: T): T & { stale: true } {
  return { ...snapshot, stale: true }
}

export function isFreshLiveSnapshot(snapshot: { live?: boolean; stale?: boolean } | null | undefined) {
  return Boolean(snapshot?.live && !snapshot?.stale)
}
