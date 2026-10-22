import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAssistantPresentation } from './assistantPresentation.ts'

const salesMessage = {
  id: 'one', role: 'assistant', question: 'what is the todays sell', intent: 'sales', content: 'A conversational summary.',
  scope: { brand: 'all', country: 'all', tz: 'Dubai', start: Date.parse('2026-10-21T20:00:00Z'), end: Date.parse('2026-10-22T10:00:00Z') },
  evidence: [{ name: 'Saleor Core', status: 'Connected', live: true, updatedAt: '2026-10-22T10:00:00Z', note: '', facts: [
    { label: 'Orders', value: '9' },
    { label: 'SAR gross value', value: '4,723' },
    { label: 'AED gross value', value: '2,555.38' },
  ] }],
}

test('sales evidence becomes the same source-labeled data table and key figures', () => {
  const result = buildAssistantPresentation(salesMessage)
  assert.equal(result.title, 'Saleor placed sales snapshot')
  assert.equal(result.rows.length, 3)
  assert.deepEqual(result.highlights, result.rows)
  assert.equal(result.rows[2].source, 'Saleor Core')
  assert.equal(result.rows[2].value, 'AED 2,555.38')
  assert.match(result.subtitle, /22 Oct 2026/)
})

test('refusals and unsupported facts do not receive invented visual metrics', () => {
  assert.equal(buildAssistantPresentation({ id: 'two', role: 'assistant', question: 'weather', content: 'Outside scope', evidence: [] }), null)
  const result = buildAssistantPresentation({ ...salesMessage, evidence: [{ ...salesMessage.evidence[0], facts: [{ label: 'Metric availability', value: 'not mapped' }] }] })
  assert.equal(result.highlights.length, 0)
  assert.equal(result.rows.length, 1)
})

test('older saved answers without intent infer a relevant table title from evidence', () => {
  const result = buildAssistantPresentation({ ...salesMessage, intent: undefined })
  assert.equal(result.title, 'Saleor placed sales snapshot')
})
