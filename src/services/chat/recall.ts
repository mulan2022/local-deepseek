import { getVisibleMessages } from './branches.js'
import { loadSession, loadSessionSummaries } from './db.js'
import { getReplyText } from './reply.js'
import type { RccSnapshot } from './types.js'

// Chat recall and BM25 adapted from dsh-mem (MIT, Copyright 2026 mulan2022).
const SESSION_LIMIT = 40
const TURNS_PER_SESSION = 12
const RECALL_BUDGET = 6_000
const MAX_PATCH_LENGTH = 600
const DREAM_REPLY_EXCERPT_LENGTH = 300

type RecallSession = {
  id: string
  title: string
  date: string
  turns: string[]
  turnIds: string[]
  turnTimes: number[]
  assistantReplies?: string[]
}

export const loadRecallSessions = async (
  folderId: string,
  currentSessionId?: string,
  limit = SESSION_LIMIT,
  selectedIds?: ReadonlySet<string>,
  includeAssistantReplies = false
): Promise<RecallSession[]> => {
  const summaries = await loadSessionSummaries(folderId)
  const recent = summaries
    .filter(({ id }) => id !== currentSessionId && (!selectedIds || selectedIds.has(id)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
  const sessions = await Promise.all(recent.map(({ id }) => loadSession(folderId, id)))
  return sessions.flatMap((session) => {
    if (!session) {
      return []
    }
    const messages = getVisibleMessages(session)
    const turns = messages.flatMap((message, index) => {
      if (message.role !== 'user' || !message.content.trim()) {
        return []
      }
      const answer = includeAssistantReplies ? messages[index + 1] : undefined
      return [{
        message,
        answer: answer?.role === 'assistant'
          ? getReplyText(answer).trim().slice(0, DREAM_REPLY_EXCERPT_LENGTH)
          : '',
      }]
    })
    return turns.length
      ? [{
          id: session.id,
          title: session.title.slice(0, 80),
          date: new Date(session.updatedAt).toLocaleDateString('sv-SE'),
          turns: turns.map(({ message }) => message.content.trim()),
          turnIds: turns.map(({ message }) => message.id),
          turnTimes: turns.map(({ message }) => message.createdAt),
          ...(includeAssistantReplies ? { assistantReplies: turns.map(({ answer }) => answer) } : {}),
        }]
      : []
  })
}

const clipTurn = (text: string) =>
  text.length > MAX_PATCH_LENGTH
    ? '[Long message omitted]'
    : text.length > 100 ? `${text.slice(0, 60)}[TL;DR]${text.slice(-40)}` : text

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+|[a-z0-9_]+/g) ?? [])
    .flatMap((word) => /^[a-z0-9_]|^.$/.test(word)
      ? [word]
      : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)))

export const rankPatch = (query: string, turns: string[]): string | undefined => {
  const terms = new Set(tokenize(query.slice(0, MAX_PATCH_LENGTH)))
  if (terms.size < 2 || !turns.length) {
    return undefined
  }
  const frequency = new Map<string, number>()
  const documents = turns.map((text) => {
    const tokens = tokenize(text)
    const counts = new Map<string, number>()
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    for (const token of counts.keys()) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
    }
    return { text, length: tokens.length, counts }
  })
  const size = documents.length
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / size || 1
  const distinctive = [...terms].filter((term) => {
    const count = frequency.get(term) ?? 0
    return count > 0 && (count < 3 || count / size <= 0.1)
  })
  let best: { text: string; score: number } | undefined
  for (const doc of documents) {
    let matches = 0
    let score = 0
    for (const term of distinctive) {
      const count = doc.counts.get(term)
      if (count) {
        matches++
        const df = frequency.get(term) ?? 0
        const idf = Math.log(1 + (size - df + 0.5) / (df + 0.5))
        score += idf * (count * 2.5) / (count + 1.5 * (0.25 + 0.75 * doc.length / average))
      }
    }
    if (matches >= 2 && (!best || score > best.score)) {
      best = { text: doc.text, score }
    }
  }
  return best?.text
}

export const buildRecentRecall = (sessions: RecallSession[]): RccSnapshot['recent'] => {
  const recent: RccSnapshot['recent'] = []
  let remaining = RECALL_BUDGET
  for (const { id, date, title, turns } of sessions) {
    const quotes: string[] = []
    for (const turn of turns.slice(0, TURNS_PER_SESSION)) {
      const excerpt = clipTurn(turn)
      if (excerpt.length + 16 > remaining) {
        break
      }
      remaining -= excerpt.length + 16
      quotes.push(excerpt)
    }
    if (quotes.length) {
      remaining = Math.max(0, remaining - title.length - 64)
      recent.push({ id, date, title, quotes })
    }
  }
  return recent.reverse()
}

export const findRccPatch = (
  sessions: RecallSession[], snapshot: RccSnapshot, question: string, seenQuotes: Set<string>
) => {
  const included = new Set(snapshot.recent.flatMap(({ quotes }) => quotes))
  const candidates = [...new Set(sessions.flatMap(({ turns, turnTimes }) =>
    turns.filter((turn, index) => turnTimes[index] <= snapshot.capturedAt &&
      turn.length > 0 && turn.length <= MAX_PATCH_LENGTH && !included.has(turn) && !seenQuotes.has(turn))
  ))].slice(0, 1_000)
  return rankPatch(question, candidates)
}
