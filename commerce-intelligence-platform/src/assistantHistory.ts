export interface AssistantSource {
  name: string
  live: boolean
  status: string
  updatedAt: string
}

export interface AssistantEvidence extends AssistantSource {
  facts: Array<{ label: string; value: string }>
  note: string
}

export interface AssistantScope {
  brand: string
  country: string
  tz: string
  start: number | null
  end: number | null
}

export interface AssistantMessage {
  id: string
  role: 'assistant' | 'user'
  content: string
  question?: string
  sources?: AssistantSource[]
  evidence?: AssistantEvidence[]
  scope?: AssistantScope
  generatedAt?: string
  exportData?: Record<string, unknown>
  mode?: 'gemini' | 'platform'
  ai?: { configured: boolean; used: boolean; status: string }
  understanding?: { mode: 'gemini' | 'rules'; status: string; intent: string; country: string; brand: string }
  intent?: string
  clarification?: string[]
}

export interface AssistantConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: AssistantMessage[]
}

export interface AssistantHistory {
  activeId: string | null
  conversations: AssistantConversation[]
}

const STORAGE_KEY = 'magrabi-commerce-assist-history-v1'
const MAX_CONVERSATIONS = 24
const MAX_MESSAGES = 80
const MAX_STORAGE_CHARS = 3_000_000

export function emptyHistory(): AssistantHistory {
  return { activeId: null, conversations: [] }
}

export function loadHistory(): AssistantHistory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw || raw.length > MAX_STORAGE_CHARS) return emptyHistory()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('conversations' in parsed) || !Array.isArray(parsed.conversations)) return emptyHistory()
    const conversations = parsed.conversations
      .filter((item): item is AssistantConversation =>
        item && typeof item.id === 'string' && typeof item.title === 'string' && Array.isArray(item.messages),
      )
      .slice(0, MAX_CONVERSATIONS)
      .map((item) => ({
        ...item,
        title: item.title.slice(0, 80),
        messages: item.messages
          .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
          .slice(-MAX_MESSAGES),
      }))
    const activeId = 'activeId' in parsed && typeof parsed.activeId === 'string' && conversations.some((item) => item.id === parsed.activeId)
      ? parsed.activeId
      : conversations[0]?.id || null
    return { activeId, conversations }
  } catch {
    return emptyHistory()
  }
}

export function saveHistory(history: AssistantHistory): boolean {
  try {
    const conversations = [...history.conversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_CONVERSATIONS)
      .map((item) => ({ ...item, messages: item.messages.slice(-MAX_MESSAGES) }))
    let payload = JSON.stringify({ activeId: history.activeId, conversations })
    while (payload.length > MAX_STORAGE_CHARS && conversations.length > 1) {
      conversations.pop()
      payload = JSON.stringify({ activeId: history.activeId, conversations })
    }
    localStorage.setItem(STORAGE_KEY, payload)
    return true
  } catch {
    return false
  }
}

export function createConversation(id: string, now = new Date().toISOString()): AssistantConversation {
  return { id, title: 'New conversation', createdAt: now, updatedAt: now, messages: [] }
}

export function appendMessage(history: AssistantHistory, threadId: string, message: AssistantMessage): AssistantHistory {
  const now = new Date().toISOString()
  const exists = history.conversations.some((item) => item.id === threadId)
  const conversations = (exists ? history.conversations : [createConversation(threadId, now), ...history.conversations])
    .map((item) => item.id === threadId
      ? {
          ...item,
          title: item.title === 'New conversation' && message.role === 'user'
            ? message.content.slice(0, 58) || 'New conversation'
            : item.title,
          updatedAt: now,
          messages: [...item.messages, message].slice(-MAX_MESSAGES),
        }
      : item,
    )
  return { activeId: threadId, conversations }
}

export function updateConversation(history: AssistantHistory, threadId: string, change: (conversation: AssistantConversation) => AssistantConversation): AssistantHistory {
  return { ...history, conversations: history.conversations.map((item) => item.id === threadId ? change(item) : item) }
}

export function deleteConversation(history: AssistantHistory, threadId: string): AssistantHistory {
  const conversations = history.conversations.filter((item) => item.id !== threadId)
  return { activeId: history.activeId === threadId ? conversations[0]?.id || null : history.activeId, conversations }
}
