import test from 'node:test'
import assert from 'node:assert/strict'
import { canAccessPath } from './router.js'

test('viewer cannot access connector inventory or alert-rule evaluation', () => {
  assert.equal(canAccessPath('viewer', '/api/commerce/auth/users'), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/health'), false)
  assert.equal(canAccessPath('viewer', '/api/commerce/alerts/evaluate'), false)
})

test('viewer retains access to operational read-only data and admin retains full access', () => {
  assert.equal(canAccessPath('viewer', '/api/commerce/orders/summary'), true)
  assert.equal(canAccessPath('viewer', '/api/commerce/traffic/edge'), true)
  assert.equal(canAccessPath('admin', '/api/commerce/health'), true)
  assert.equal(canAccessPath('admin', '/api/commerce/alerts/evaluate'), true)
})
