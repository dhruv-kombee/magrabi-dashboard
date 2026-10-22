import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendMessage, createConversation, deleteConversation, emptyHistory, loadHistory, saveHistory,
} from './assistantHistory.ts'

test('conversation history persists and reopens the active thread', () => {
  const values = new Map()
  const originalStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  try {
    const thread = createConversation('thread-1', '2026-10-22T00:00:00Z')
    let history = { activeId: thread.id, conversations: [thread] }
    history = appendMessage(history, thread.id, { id: 'message-1', role: 'user', content: 'Show Saudi revenue' })
    history = appendMessage(history, thread.id, { id: 'message-2', role: 'assistant', content: 'SAR 1,000', evidence: [] })
    assert.equal(saveHistory(history), true)
    const restored = loadHistory()
    assert.equal(restored.activeId, thread.id)
    assert.equal(restored.conversations[0].title, 'Show Saudi revenue')
    assert.equal(restored.conversations[0].messages.length, 2)
    assert.equal(restored.conversations[0].messages[1].content, 'SAR 1,000')
  } finally {
    globalThis.localStorage = originalStorage
  }
})

test('deleting a thread selects the next available conversation', () => {
  const first = createConversation('first')
  const second = createConversation('second')
  const result = deleteConversation({ activeId: 'first', conversations: [first, second] }, 'first')
  assert.equal(result.activeId, 'second')
  assert.equal(result.conversations.length, 1)
  assert.deepEqual(emptyHistory(), { activeId: null, conversations: [] })
})
