import type { ClientTool, ToolUseBlock } from '../api/types.js'
import { dreamPendingCount, runDream, useDreamState } from './dream.js'
import { PINNED_LIMIT, readMemory, saveChatMemory, SECTION_KEYS } from './memory.js'
import { withoutMemorySources } from './memorySources.js'
import { loadRecallSessions, tokenize } from './recall.js'
import type { Message, UserMessage } from './types.js'

const field = (description: string, choices?: readonly string[]) =>
  ({ type: 'string' as const, description, ...(choices ? { enum: choices } : {}) })
const tool = (
  name: string, description: string, properties: ClientTool['input_schema']['properties']
): ClientTool => ({
  name, description,
  input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
})

export const memoryTools = [
  tool('mem_search', 'Search the local chat vault and past user messages for a relevant detail.', {
    query: field('Search keywords or a short question'),
  }),
  tool('mem_entity', 'Read a locally stored entity by exact name or alias.', {
    name: field('Name or alias'),
  }),
  tool('mem_remember', 'Add a pinned memory only when the current user explicitly asks you to remember it.', {
    text: field('One concise memory to save'),
  }),
  tool('mem_forget', 'Remove one pinned memory only when the current user explicitly asks you to forget it.', {
    text: field('Exact text or a distinctive phrase from the pinned memory'),
  }),
  tool('mem_observe', 'Record a supported observation when the user asks for it or explicitly corrects an existing observation.', {
    text: field('Observation, including its context and limits'),
    confidence: field('Evidence strength', ['confirmed', 'observed', 'tentative']),
  }),
  tool('mem_dream', 'Check Dream status, or on explicit user request run Dream or change whether this chat is skipped.', {
    action: field('Dream action for the current chat or the vault', ['status', 'run', 'skip', 'unskip']),
  }),
]

type ToolContext = { sessionId: string; question: UserMessage; apiKey: string; signal: AbortSignal; compactedHistory?: Message[] }
type ToolResponse = { ok: boolean; message: string; data?: unknown }

const ok = (message: string, data?: unknown): ToolResponse => ({ ok: true, message, data })
const fail = (message: string): ToolResponse => ({ ok: false, message })
const argument = (input: unknown, key: string, max: number) => {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, key)) {
    return ''
  }
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length <= max ? value.trim() : ''
}

const normalized = (text: string) => text.normalize('NFKC').trim().toLowerCase()
const allowRemember = /(?:记住|记下来|记一下|记入|加到.{0,6}记忆|保存.{0,6}记忆|以后都|remember|save.{0,8}memor)/i
const allowForget = /(?:忘掉|忘了这|忘记|删.{0,12}记忆|从记忆里.{0,8}删|forget|remove.{0,12}memor)/i
const allowObserve = /(?:观察|修正|纠正|更正|改一下.{0,8}记忆|observ|correct|update.{0,8}memor)/i
const denyAction = /(?:别|不要|不用|不必|暂不|无需|don't |do not |never )\s*(?:再|去|替我|帮我)?\s*(?:记|忘|删|写|运行|整理|跳过|remember|forget|run|skip)/i
const capabilityQuestion = /^(?:(?:请问|话说|想问下)\s*[,，：:]?\s*)?(?:你(?:会|能|可以|有没有|是否)|do you|can you|how (?:do|can))/i

const searchMemory = async (query: string, sessionId: string, compactedHistory?: Message[]) => {
  const memory = readMemory()
  const sessions = memory.enabled ? await loadRecallSessions(sessionId) : []
  const vaultDocuments = memory.enabled ? [
    ...memory.pinned.split('\n').map((text) => ({ kind: 'pinned', text })),
    ...SECTION_KEYS.map((section) => ({
      kind: section, text: memory.sections[section], sources: memory.sectionSources[section],
    })),
    ...memory.observations.map(({ text, source }) => ({ kind: 'observation', text, source })),
    ...memory.entities.map(({ name, aliases, text, source }) =>
      ({ kind: 'entity', text: [name, ...aliases, text].join(' · '), source })
    ),
    ...sessions.flatMap(({ id, title, turns, turnIds }) => turns.map((text, index) =>
      ({ kind: 'chat', text, title, source: `${id}:${turnIds[index]}` })
    )),
  ] : []
  const documents = [
    ...(compactedHistory ?? []).flatMap((message) => message.role === 'user'
      ? message.heartbeat ? [] : [{ kind: 'current_chat', text: message.content }]
      : message.blocks.flatMap((block) => block.type === 'text' && !block.isTemplate
        ? [{ kind: 'current_chat', text: block.text }] : [])),
    ...vaultDocuments,
  ]
  const terms = [...new Set(tokenize(query))]
  const needle = normalized(query)
  return documents.map((entry) => {
    const body = normalized(entry.text)
    const matched = terms.filter((term) => body.includes(term))
    const exact = body.indexOf(needle)
    const position = exact >= 0 ? exact : body.indexOf(matched[0] ?? '')
    const start = Math.max(0, position - 125)
    return {
      entry: { ...entry, text: entry.text.slice(start, start + 600) },
      score: (exact >= 0 ? terms.length + 3 : 0) + matched.length,
    }
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ entry }) => entry)
}

export const executeMemoryTool = async (call: ToolUseBlock, context: ToolContext): Promise<ToolResponse> => {
  const { input, name } = call
  const { question, sessionId, signal, apiKey, compactedHistory } = context
  const memory = readMemory()
  if (signal.aborted) {
    return fail('本轮已停止。')
  }
  if (!memory.enabled && !(name === 'mem_search' && compactedHistory)) {
    return fail('本轮已停止，或跨会话记忆已关闭。')
  }
  if (name === 'mem_search') {
    const query = argument(input, 'query', 200)
    return query ? ok('检索完成，返回的是历史资料。', await searchMemory(query, sessionId, compactedHistory)) : fail('请提供检索词。')
  }
  if (name === 'mem_entity') {
    const nameOrAlias = normalized(argument(input, 'name', 80))
    if (!nameOrAlias) {
      return fail('请提供实体名称。')
    }
    const found = memory.entities.filter((entry) =>
      [entry.name, ...entry.aliases].some((alias) => normalized(alias) === nameOrAlias)
    )
    const data = found.map((entry) => ({
      ...entry,
      relatedNames: memory.entities.filter((other) => other !== entry &&
        [other.name, ...other.aliases].some((alias) => alias.length >= 2 && normalized(entry.text).includes(normalized(alias)))
      ).map((other) => other.name).slice(0, 12),
    }))
    return data.length ? ok('已找到实体。', withoutMemorySources(data)) : fail('没有找到同名或同别名的实体。')
  }

  const action = argument(input, 'action', 12)
  if (name === 'mem_dream' && action === 'status') {
    return ok('Dream 状态。', {
      running: useDreamState.getState().running, lastDream: memory.lastDream,
      autoDream: memory.autoDream, skipped: memory.skippedSessions.includes(sessionId),
      pendingCount: await dreamPendingCount(), skippedCount: memory.skippedSessions.length,
    })
  }
  if (question.heartbeat) {
    return fail('本轮由应用唤醒。修改记忆或执行 Dream 需要用户本轮明确提出。')
  }
  const request = question.content
  if (denyAction.test(request) || (capabilityQuestion.test(request.trim()) &&
    /(?:吗[？?]?|[？?])\s*$/.test(request) && !/(?:帮我|替我|为我|for me)/i.test(request))) {
    return fail('本轮包含不修改或不运行的要求，未执行。')
  }
  if (name === 'mem_remember' && allowRemember.test(request)) {
    const text = argument(input, 'text', 500).replace(/\s+/g, ' ')
    if (!text) {
      return fail('请提供一条有效记忆。')
    }
    const lines = memory.pinned.split('\n').filter((line) => line.trim())
    if (lines.some((line) => normalized(line) === normalized(text))) {
      return ok('这条已经在常驻记忆里。', { text })
    }
    const pinned = [...lines, text].join('\n')
    if (lines.length >= 50 || pinned.length > PINNED_LIMIT) {
      return fail('常驻记忆已满。')
    }
    saveChatMemory({ pinned })
    return ok('已写入常驻记忆。', { text })
  }
  if (name === 'mem_forget' && allowForget.test(request)) {
    const needle = normalized(argument(input, 'text', 500))
    const lines = memory.pinned.split('\n')
    const exact = lines.filter((line) => needle && normalized(line) === needle)
    const matches = exact.length ? exact : lines.filter((line) => needle.length >= 2 && normalized(line).includes(needle))
    if (matches.length !== 1) {
      return fail(matches.length ? '匹配多条常驻记忆，请先明确是哪一条。' : '没有找到对应的常驻记忆。')
    }
    saveChatMemory({ pinned: lines.filter((line) => line !== matches[0]).join('\n') })
    return ok('已删除对应的常驻记忆。', { text: matches[0] })
  }
  if (name === 'mem_observe' && allowObserve.test(request)) {
    const text = argument(input, 'text', 600)
    const confidence = argument(input, 'confidence', 12)
    if (!text || (confidence !== 'confirmed' && confidence !== 'observed' && confidence !== 'tentative')) {
      return fail('缺少观察正文或有效的置信等级。')
    }
    const observations = memory.observations.filter((item) => normalized(item.text) !== normalized(text))
    if (observations.length >= 50) {
      return fail('观察记录已满。')
    }
    saveChatMemory({ observations: [{ text, confidence, source: `${sessionId}:${question.id}` }, ...observations] })
    return ok('已保存行为观察。', { text, confidence })
  }
  if (name === 'mem_dream') {
    if (action === 'run' && /(?:运行|启动|跑|整理|run|start).{0,12}(?:dream|记忆)|dream.{0,12}(?:一次|整理|现在)/i.test(request)) {
      const result = await runDream(apiKey, () => !signal.aborted && readMemory().enabled)
      if (result === 'failed' || result === 'busy') {
        return fail(result === 'busy' ? '已有 Dream 任务在运行。' : 'Dream 整理失败，原进度保留。')
      }
      if (result === 'selectionRequired') {
        return fail('首次 Dream 请在聊天记忆的 Dream 页选择最多 10 个会话。')
      }
      return ok(result === 'empty' ? '没有待整理的轮次。' : 'Dream 已更新聊天记忆。')
    }
    if ((action === 'skip' || action === 'unskip') && /(?:跳过|排除|skip|恢复|重新纳入).{0,16}(?:dream|整理|记忆)|(?:dream|整理).{0,16}(?:跳过|skip|恢复)/i.test(request)) {
      const skipped = memory.skippedSessions.filter((id) => id !== sessionId)
      saveChatMemory({ skippedSessions: action === 'skip' ? [...skipped, sessionId] : skipped })
      return ok(action === 'skip' ? '当前会话已跳过 Dream。' : '当前会话已恢复 Dream。')
    }
  }
  return fail('只有本轮用户明确提出时才执行写入、删除或 Dream 操作。')
}
