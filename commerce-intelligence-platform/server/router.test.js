import test from 'node:test'
import assert from 'node:assert/strict'
import { canAccessPath } from './router.js'
import { DEFAULT_VIEWER_PERMISSIONS, VIEWER_PERMISSIONS } from './userStore.js'

test('viewer module permissions govern APIs while user management stays admin-only', () => {
  const trafficOnly = ['traffic']
  assert.equal(canAccessPath('viewer', '/api/commerce/auth/users'), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/traffic/edge', trafficOnly), true)
  assert.equal(canAccessPath('viewer', '/api/commerce/orders/summary', trafficOnly), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/health', trafficOnly), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/alerts/evaluate', trafficOnly), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/assistant/query', trafficOnly), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/assistant/query', VIEWER_PERMISSIONS), true)
})

test('default viewers retain existing sections and admins bypass module restrictions', () => {
  assert.equal(canAccessPath('viewer', '/api/commerce/orders/summary'), true)
  assert.equal(canAccessPath('viewer', '/api/commerce/traffic/edge'), true)
  assert.equal(canAccessPath('viewer', '/api/commerce/health'), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/alerts/evaluate'), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/health', VIEWER_PERMISSIONS), true)
  assert.equal(canAccessPath('viewer', '/api/commerce/alerts/evaluate', VIEWER_PERMISSIONS), true)
  assert.deepEqual(DEFAULT_VIEWER_PERMISSIONS, ['overview', 'orders', 'journey', 'traffic', 'infra'])
  assert.equal(canAccessPath('admin', '/api/commerce/orders/summary', []), true)
  assert.equal(canAccessPath('admin', '/api/commerce/health'), true)
  assert.equal(canAccessPath('admin', '/api/commerce/auth/users'), true)
})
