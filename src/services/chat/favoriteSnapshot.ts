import { normalizeSession } from './branches.js'
import { favoriteId, type FavoriteSnapshot, type FavoriteSummary } from './favoriteTypes.js'
import type { AssistantMessage, Message, Session } from './types.js'

export const createFavoriteSnapshot = (source: Session, messageId: string, likedText: string, savedAt = Date.now()): {
  summary: FavoriteSummary
  snapshot: FavoriteSnapshot
} => {
  const session = normalizeSession(source)
  const byId = new Map(session.messages.map(message => [message.id, message]))
  const target = byId.get(messageId)
  if (target?.role !== 'assistant' || target.status === 'pending' || target.status === 'streaming' ||
      target.stopReason === 'refusal' || !likedText.trim()) {
    throw new Error('Reply is not ready to favorite')
  }
  const path: Message[] = []
  const seen = new Set<string>()
  let message: Message | undefined = target
  while (message) {
    if (seen.has(message.id)) { throw new Error('Cyclic conversation branch') }
    seen.add(message.id)
    path.push(message)
    if (!message.parentId) { break }
    const parent = byId.get(message.parentId)
    if (!parent) { throw new Error('Incomplete conversation branch') }
    message = parent
  }
  path.reverse()
  const frozen: Session = JSON.parse(JSON.stringify({
    ...session, rootMessageId: path[0]?.id ?? null,
    messages: path.map((item, index) => ({ ...item, selectedChildId: path[index + 1]?.id })),
  })) as Session
  const reply = frozen.messages.at(-1) as AssistantMessage
  const id = favoriteId(source.folderId, source.id, messageId)
  return {
    summary: {
      id, sourceFolderId: source.folderId, sessionId: source.id, messageId,
      sessionTitle: source.title, savedAt,
      provider: reply.provider ?? 'deepseek', model: reply.model,
      preview: likedText.slice(0, 400), contextCount: Math.max(0, path.length - 1),
    },
    snapshot: {
      version: 1, id, savedAt, messageId, likedText,
      session: frozen, files: [], missingFileIds: [],
    },
  }
}
