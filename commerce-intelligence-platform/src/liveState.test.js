import test from 'node:test'
import assert from 'node:assert/strict'
import { isFreshLiveSnapshot, markSnapshotStale } from './liveState.ts'

test('cached or failed snapshots are visually gated as stale, not fresh live data', () => {
  const stale = markSnapshotStale({ live: true, orders: 12 })
  assert.equal(stale.stale, true)
  assert.equal(isFreshLiveSnapshot(stale), false)
  assert.equal(isFreshLiveSnapshot({ live: true, stale: false }), true)
  assert.equal(isFreshLiveSnapshot({ live: false }), false)
})
