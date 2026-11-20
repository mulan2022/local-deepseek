import { create } from 'zustand'
import { buildRecentRecall, findRccPatch, loadRecallSessions } from './recall.js'
import { publicMemoryPayload, splitMemorySources, withoutMemorySources } from './memorySources.js'
import { chatMemoryInstructions, hasChatRecallInstructions } from './memoryPrompts.js'
import type { ChatMemoryFrame, RccSnapshot } from './types.js'
import {
  CHAT_MEMORY_STORAGE_KEY as STORAGE_KEY,
  getActiveFolderId,
  readFolderValue,
  scopedStorageKey,
  writeFolderValue,
} from './folderStorage.js'

export const SECTION_KEYS = ['personal', 'work', 'thisMonth', 'earlierMonths', 'taste', 'tips'] as const
export type MemorySection = (typeof SECTION_KEYS)[number]
export type Observation = { text: string; confidence: 'confirmed' | 'observed' | 'tentative'; source: string }
export type MemoryEntity = { name: string; aliases: string[]; text: string; source: string }
export type DreamCheckpoint = { messageId: string; digest: string }
export type MemoryVault = {
  sections: Record<MemorySection, string>
  sectionSources: Partial<Record<MemorySection, string[]>>
  observations: Observation[]
  entities: MemoryEntity[]
}
export type ChatMemory = MemoryVault & {
  enabled: boolean
  autoDream: boolean
  pinned: string
  month: string
  lastDream: number
  checkpoints: Record<string, DreamCheckpoint>
  skippedSessions: string[]
  nextDreamSessionIds: string[] | null
  dreamNeedsSelection: boolean
  log: { at: number; sessions: number }[]
}

export const PINNED_LIMIT = 4_000
export const SECTION_LIMIT = 2_000
const emptySections: MemoryVault['sections'] = {
  personal: '', work: '', thisMonth: '', earlierMonths: '', taste: '', tips: '',
}
export const monthKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

const cleanStoredMemory = (memory: ChatMemory): ChatMemory => {
  const sections = { ...memory.sections }
  const sectionSources: MemoryVault['sectionSources'] = {}
  for (const key of SECTION_KEYS) {
    const { text, sources } = splitMemorySources(sections[key])
    sections[key] = text
    const combined = [...new Set([...(memory.sectionSources[key] ?? []), ...sources])]
    if (text.trim() && combined.length) {
      sectionSources[key] = combined
    }
  }
  return {
    ...memory,
    pinned: splitMemorySources(memory.pinned).text,
    sections, sectionSources,
    observations: memory.observations.map((item) => ({ ...item, text: splitMemorySources(item.text).text })),
    entities: memory.entities.map((item) => ({ ...item, text: splitMemorySources(item.text).text })),
  }
}

export const readMemory = (folderId = getActiveFolderId()): ChatMemory => {
  const defaults: ChatMemory = {
    enabled: false, autoDream: true, pinned: '', month: monthKey(new Date()), lastDream: 0,
    sections: emptySections, sectionSources: {}, observations: [], entities: [], checkpoints: {}, skippedSessions: [],
    nextDreamSessionIds: null, dreamNeedsSelection: false, log: [],
  }
  try {
    const stored = JSON.parse(readFolderValue(folderId, STORAGE_KEY) ?? 'null')
    if (!stored || typeof stored !== 'object') {
      return defaults
    }
    // Keep the single summary from v0.1.2 as an archive entry.
    const legacy = typeof stored.summary === 'string' ? stored.summary : ''
    delete stored.summary
    return cleanStoredMemory({
      ...defaults, ...stored,
      sections: { ...emptySections, earlierMonths: legacy, ...stored.sections },
    })
  } catch {
    return defaults
  }
}

export const useChatMemory = create<ChatMemory>(() => readMemory())

export const activateChatMemory = (folderId: string) => {
  useChatMemory.setState(readMemory(folderId))
}

export const saveChatMemory = (update: Partial<ChatMemory>, folderId = getActiveFolderId()) => {
  const next = cleanStoredMemory({ ...readMemory(folderId), ...update })
  writeFolderValue(folderId, STORAGE_KEY, JSON.stringify(next))
  if (folderId === getActiveFolderId()) {
    useChatMemory.setState(next)
  }
}

export const syncChatMemory = (event: StorageEvent) => {
  if (event.key === scopedStorageKey(getActiveFolderId(), STORAGE_KEY) || event.key === null) {
    useChatMemory.setState(readMemory())
  }
}

export const captureRcc = async (folderId: string, sessionId: string): Promise<RccSnapshot | null> => {
  if (!readMemory(folderId).enabled) {
    return null
  }
  const capturedAt = Date.now()
  const sessions = await loadRecallSessions(folderId, sessionId).catch(() => [])
  return { capturedAt, recent: buildRecentRecall(sessions) }
}

export const buildChatMemoryFrame = async (
  folderId: string, sessionId: string, snapshot: RccSnapshot | null | undefined,
  previousFrames: ChatMemoryFrame[], question: string
): Promise<ChatMemoryFrame | undefined> => {
  const { enabled, pinned, sections, entities } = readMemory(folderId)
  if (!enabled) {
    return
  }
  const needsGuide = !previousFrames.some((frame) => frame.hasGuide)
  const recent = snapshot?.recent.length && !previousFrames.some((frame) => frame.hasRcc)
    ? snapshot.recent.map(({ date, title, quotes }) => ({ date, title, quotes }))
    : undefined
  const coveredIds = new Set(snapshot?.recent.map(({ id }) => id))
  const seenQuotes = new Set(previousFrames.flatMap(({ relatedQuote }) => relatedQuote ? [relatedQuote] : []))
  const relatedQuote = snapshot && coveredIds.size && question.trim()
    ? findRccPatch(
        await loadRecallSessions(folderId, sessionId, coveredIds.size, coveredIds).catch(() => []),
        snapshot, question, seenQuotes
      )
    : undefined
  const needsRecallGuide = Boolean(recent || relatedQuote) ||
    (previousFrames.some((frame) => frame.hasRcc || frame.relatedQuote) &&
      !previousFrames.some((frame) => hasChatRecallInstructions(frame.instructions)))
  const currentVault = pinned || Object.values(sections).some(Boolean) ? { pinned, sections } : null
  const vaultSnapshot = JSON.stringify(withoutMemorySources(currentVault))
  const previousVault = [...previousFrames].reverse().find((frame) => frame.vaultSnapshot !== undefined)
  const vaultChanged = vaultSnapshot !== publicMemoryPayload(previousVault?.vaultSnapshot ?? 'null')
  const query = question.toLowerCase()
  const relevantEntities = entities.filter((entity) =>
    [entity.name, ...entity.aliases].some((name) => name.length >= 2 && query.includes(name.toLowerCase()))
  ).slice(0, 4)
  if (!needsGuide && !needsRecallGuide && !vaultChanged && !relevantEntities.length) {
    return
  }
  return {
    instructions: chatMemoryInstructions(needsGuide, needsRecallGuide),
    ...(needsGuide ? { hasGuide: true } : {}),
    payload: JSON.stringify({
      vault: vaultChanged ? withoutMemorySources(currentVault) : undefined,
      recent, relatedQuote,
      entities: relevantEntities.length ? withoutMemorySources(relevantEntities) : undefined,
    }),
    ...(recent ? { hasRcc: true } : {}),
    ...(vaultChanged ? { vaultSnapshot } : {}),
    relatedQuote,
  }
}
