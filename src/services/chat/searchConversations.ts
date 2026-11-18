import { getVisibleMessages } from './branches.js'
import { loadSession } from './db.js'
import { getReplyText } from './reply.js'
import { useChatStore } from './store.js'
import type { SessionSummary } from './types.js'

const sentenceBoundary = /[。！？!?…]+|\.+(?=\s)|\n/

const matchSentence = (text: string, keyword: RegExp, messageId: string) => {
  const match = keyword.exec(text)
  if (!match) {
    return undefined
  }
  const left = text.slice(0, match.index).split(sentenceBoundary).at(-1)?.trimStart() ?? ''
  const right = text.slice(match.index + match[0].length)
  const end = sentenceBoundary.exec(right)
  const tail = (end ? right.slice(0, end.index + end[0].length) : right).trimEnd()
  return {
    messageId,
    before: left.length > 28 ? `…${left.slice(-28)}` : left,
    hit: match[0],
    after: tail.length > 90 ? `${tail.slice(0, 90)}…` : tail,
  }
}

export type ConversationMatch = {
  session: SessionSummary
  snippet?: NonNullable<ReturnType<typeof matchSentence>>
}

/** 按会话列表顺序逐条读取本地详情，只保留每个会话最新的正文命中。 */
export const searchConversations = async (
  sessions: readonly SessionSummary[],
  query: string,
  signal: AbortSignal,
): Promise<ConversationMatch[]> => {
  const text = query.trim()
  if (!text) {
    return []
  }
  const keyword = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  const results: ConversationMatch[] = []
  for (const summary of sessions) {
    signal.throwIfAborted()
    const cache = useChatStore.getState().sessionCache
    const session = Object.hasOwn(cache, summary.id)
      ? cache[summary.id]
      : await loadSession(summary.id)
    const messages = session ? getVisibleMessages(session) : []
    let snippet
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      const content = message.role === 'user' ? message.content : getReplyText(message)
      snippet = matchSentence(content, keyword, message.id)
      if (snippet) {
        break
      }
    }
    if (snippet || keyword.test(summary.title)) {
      results.push({ session: summary, snippet })
    }
  }
  return results
}
