import { create } from 'zustand'
import { streamMessage } from '../api/client.js'
import { useSettings } from '../settings.js'
import {
  monthKey, readMemory, saveChatMemory, SECTION_KEYS, SECTION_LIMIT,
  type DreamCheckpoint, type MemoryEntity, type MemoryVault, type Observation,
} from './memory.js'
import { loadRecallSessions } from './recall.js'
import { splitMemorySources } from './memorySources.js'
import { DREAM_EXTRACT_PROMPT, DREAM_MERGE_PROMPT } from './memoryPrompts.js'

const MINUTE = 60_000
const BATCH_SIZE = 6
export const DREAM_SELECTION_LIMIT = 10
const TURNS_PER_EXTRACTION = 24
const LOCK_NAME = 'chat-demo:memory-dream'
type DreamResult = 'saved' | 'empty' | 'busy' | 'failed' | 'selectionRequired'

export const useDreamState = create<{ running: boolean; result: DreamResult | null }>(() => ({
  running: false, result: null,
}))

export const isDreamDue = (now: number, lastDream: number, lastActivity: number) => {
  const threshold = new Date(now)
  threshold.setHours(3, 0, 0, 0)
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  return now >= +threshold && lastDream < dayStart &&
    now - lastDream >= 360 * MINUTE && now - lastActivity >= 15 * MINUTE
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Dream object')
  }
  return value as Record<string, unknown>
}

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max) {
    throw new Error('Invalid Dream text')
  }
  return value.trim()
}

const list = <T>(value: unknown, max: number, parse: (item: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error('Invalid Dream list')
  }
  return value.map(parse)
}

const requestJson = async (apiKey: string, system: string, input: unknown) => {
  let output = ''
  let complete = false
  const stream = streamMessage(apiKey, {
    model: 'deepseek-flash', system,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    thinking: { type: 'disabled' }, tools: [], safety_check: { level: 'high' },
  }, AbortSignal.timeout(120_000))
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      output += event.delta.text
      if (output.length > 42_000) {
        throw new Error('Dream response too long')
      }
    }
    if (event.type === 'message_delta') {
      complete = event.delta.stop_reason === 'end_turn'
    }
  }
  if (!complete) {
    throw new Error('Dream response interrupted')
  }
  return object(JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')))
}

const confidence = (value: unknown): Observation['confidence'] => {
  if (value === 'confirmed' || value === 'observed' || value === 'tentative') {
    return value
  }
  throw new Error('Invalid confidence')
}

const sourceOf = (value: unknown, sources: Set<string>) => {
  const source = text(value, 160)
  if (!sources.has(source)) {
    throw new Error('Unknown Dream source')
  }
  return source
}

const mergeVault = (
  old: MemoryVault, result: Record<string, unknown>, sources: Set<string>
): MemoryVault => {
  const sections = { ...old.sections }
  const sectionSources = { ...old.sectionSources }
  const changes = object(result.sections)
  const references = result.sectionSources === undefined ? {} : object(result.sectionSources)
  for (const key of SECTION_KEYS) {
    if (Object.hasOwn(changes, key)) {
      const value = splitMemorySources(text(changes[key], SECTION_LIMIT))
      sections[key] = value.text
      const changed = value.text !== old.sections[key]
      const reported = references[key] === undefined
        ? (changed ? [] : sectionSources[key] ?? [])
        : list(references[key], 50, (source) => text(source, 160))
      const verified = [...new Set([...reported, ...value.sources])]
        .filter((source) => sources.has(source)).slice(0, 50)
      if (value.text && changed && !verified.length) {
        throw new Error('Missing Dream section evidence')
      }
      sectionSources[key] = value.text ? verified : []
    }
  }
  const observations = list(result.observations, 50, (value): Observation => {
    const item = object(value)
    return { text: splitMemorySources(text(item.text, 600)).text, confidence: confidence(item.confidence), source: sourceOf(item.source, sources) }
  }).filter((item) => item.text)
  const entities = list(result.entities, 50, (value): MemoryEntity => {
    const item = object(value)
    return {
      name: text(item.name, 80), aliases: list(item.aliases, 8, (alias) => text(alias, 80)),
      text: splitMemorySources(text(item.text, 600)).text, source: sourceOf(item.source, sources),
    }
  }).filter((item) => item.name && item.text)
  return { sections, sectionSources, observations, entities }
}

const prepareBatch = async (
  checkpoints: Record<string, DreamCheckpoint>, skipped: string[], selectedIds?: ReadonlySet<string>,
  includeAssistantReplies = false
) => {
  const sessions = await loadRecallSessions(undefined, Infinity, selectedIds, includeAssistantReplies)
  return sessions.reverse().flatMap((session) => {
    if (skipped.includes(session.id)) {
      return []
    }
    const previous = checkpoints[session.id]
    const checkpointIndex = previous ? session.turnIds.indexOf(previous.messageId) : -1
    const first = checkpointIndex + 1
    if (first === session.turns.length) {
      return []
    }
    const turns = session.turns.slice(first, first + TURNS_PER_EXTRACTION).map((turn, index) => {
      const position = first + index
      const assistantText = session.assistantReplies?.[position]
      return {
        source: `${session.id}:${session.turnIds[position]}`,
        date: new Date(session.turnTimes[position]).toLocaleDateString('sv-SE'),
        text: turn.length > 900 ? `${turn.slice(0, 540)}[TL;DR]${turn.slice(-360)}` : turn,
        ...(assistantText ? { assistantText } : {}),
      }
    })
    return [{
      id: session.id, date: session.date, turns,
      title: session.title,
      previousDigest: checkpointIndex >= 0 ? previous.digest : '',
      messageId: session.turnIds[first + turns.length - 1],
      more: first + turns.length < session.turns.length,
    }]
  })
}

export const dreamPendingCount = async () => {
  const memory = readMemory()
  return (await prepareBatch(memory.checkpoints, memory.skippedSessions)).length
}

export const loadDreamCandidates = async () => {
  const memory = readMemory()
  return (await prepareBatch(memory.checkpoints, [])).reverse().map(({ id, date, title }) => ({
    id, date, title, skipped: memory.skippedSessions.includes(id),
  }))
}

export type DreamOptions = { automatic?: boolean; sessionIds?: readonly string[] }

const processBatch = async (apiKey: string, canCommit: () => boolean, options: DreamOptions) => {
  const previous = readMemory()
  const firstRun = previous.dreamNeedsSelection || previous.log.length === 0
  const selected = options.sessionIds ?? previous.nextDreamSessionIds
  if (firstRun && !selected?.length) {
    return 'selectionRequired'
  }
  const selectedIds = selected === null ? undefined : new Set(selected.slice(0, DREAM_SELECTION_LIMIT))
  const pending = await prepareBatch(
    previous.checkpoints, options.automatic ? previous.skippedSessions : [], selectedIds, true
  )
  const batch = selectedIds ? pending : pending.slice(0, BATCH_SIZE)
  if (!batch.length) {
    return 'empty'
  }
  const checkpoints = { ...previous.checkpoints }
  const oldVault: MemoryVault = {
    sections: { ...previous.sections }, sectionSources: { ...previous.sectionSources },
    observations: previous.observations, entities: previous.entities,
  }
  const now = new Date()
  const month = monthKey(now)
  if (month !== previous.month && oldVault.sections.thisMonth) {
    const archived = `${previous.month}\n${oldVault.sections.thisMonth}`
    oldVault.sections.earlierMonths = `${archived}\n\n${oldVault.sections.earlierMonths}`.slice(0, SECTION_LIMIT)
    oldVault.sections.thisMonth = ''
    oldVault.sectionSources.earlierMonths = [...new Set([
      ...(oldVault.sectionSources.thisMonth ?? []), ...(oldVault.sectionSources.earlierMonths ?? []),
    ])].slice(0, 50)
    delete oldVault.sectionSources.thisMonth
  }
  const sources = new Set([
    ...[...oldVault.observations, ...oldVault.entities].map((item) => item.source),
    ...Object.values(oldVault.sectionSources).flat(),
  ])
  const extracts = []
  for (const session of batch) {
    if (!canCommit()) {
      throw new Error('Dream paused')
    }
    const known = new Set(session.turns.map((turn) => turn.source))
    const result = await requestJson(apiKey, DREAM_EXTRACT_PROMPT, {
      title: session.title, date: session.date, previousDigest: session.previousDigest, turns: session.turns,
    })
    const findings = list(result.findings, 12, (value) => object(value))
      .filter((item) => typeof item.source === 'string' && known.has(item.source))
      .map((item) => ({
        section: text(item.section, 32), text: text(item.text, 400),
        source: sourceOf(item.source, known), name: text(item.name, 80),
        confidence: confidence(item.confidence),
      }))
    for (const item of findings) {
      sources.add(item.source)
    }
    extracts.push(...findings)
    checkpoints[session.id] = { messageId: session.messageId, digest: text(result.digest, 1_200) }
  }
  const vault = extracts.length
    ? mergeVault(oldVault, await requestJson(apiKey, DREAM_MERGE_PROMPT, {
      today: now.toLocaleDateString('sv-SE'), month, oldVault, findings: extracts,
    }), sources)
    : oldVault
  if (!canCommit()) {
    throw new Error('Dream paused')
  }
  const current = readMemory()
  if (JSON.stringify(current.sections) !== JSON.stringify(previous.sections) ||
    JSON.stringify(current.sectionSources) !== JSON.stringify(previous.sectionSources) ||
    JSON.stringify(current.observations) !== JSON.stringify(previous.observations) ||
    JSON.stringify(current.entities) !== JSON.stringify(previous.entities) ||
    JSON.stringify(current.skippedSessions) !== JSON.stringify(previous.skippedSessions)) {
    throw new Error('Memory was edited during Dream')
  }
  const more = pending.length > batch.length || batch.some((session) => session.more)
  const processed = new Set(batch.map((session) => session.id))
  const remainingSelection = current.nextDreamSessionIds?.filter((id) => !processed.has(id))
  const at = Date.now()
  saveChatMemory({
    ...vault, checkpoints, month,
    dreamNeedsSelection: false,
    ...(remainingSelection ? { nextDreamSessionIds: remainingSelection.length ? remainingSelection : null } : {}),
    ...(firstRun || selectedIds || !more ? { lastDream: at } : {}),
    log: [{ at, sessions: batch.length }, ...current.log].slice(0, 25),
  })
  return 'saved'
}

export const runDream = async (
  apiKey: string, canCommit: () => boolean = () => true, options: DreamOptions = {}
): Promise<DreamResult> => {
  if (useDreamState.getState().running) {
    return 'busy'
  }
  const canSave = () => useSettings.getState().apiKey === apiKey && canCommit()
  useDreamState.setState({ running: true, result: null })
  let result: DreamResult = 'failed'
  const run = async (): Promise<DreamResult> => {
    if (!canSave()) {
      return 'busy'
    }
    return await processBatch(apiKey, canSave, options)
  }
  try {
    result = navigator.locks
      ? await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => lock ? run() : 'busy')
      : await run()
  } catch {
    result = 'failed'
  } finally {
    useDreamState.setState({ running: false, result })
  }
  return result
}
