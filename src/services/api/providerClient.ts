import { API_ORIGIN, ApiError, readMessagesStream, request } from './client.js'
import { providers, type ModelSelection, type ProviderId } from './providers.js'
import { providerTransport } from './providerTransport.js'
import { readServerSentEvents } from './sse.js'
import { streamClientTools, type RunClientTool } from './toolStep.js'
import type {
  ClientTool,
  ContentBlockDelta,
  InlineImageBlock,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
  ToolResultBlock,
} from './types.js'

type ModelPage = {
  data?: { id?: string }[]
  has_more?: boolean
  last_id?: string
  output?: { total?: number; models?: { model?: string }[] }
}

const authHeaders = (provider: ProviderId, apiKey: string): Record<string, string> =>
  provider === 'claude'
    ? {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      }
    : { Authorization: `Bearer ${apiKey}` }

const modelId = (provider: ProviderId, id: string) =>
  provider === 'gemini' ? id.replace(/^models\//, '') : id

const isChatModel = (provider: ProviderId, model: string) => {
  if (provider === 'openai') {
    return (
      /^(gpt-|o\d)/.test(model) &&
      !/image|audio|realtime|transcrib|tts|search|instruct|deep-research|embedding/i.test(model)
    )
  }
  if (provider === 'gemini') {
    return /^gemini-/.test(model) && !/embed|image|live|tts|audio|robotics|computer-use/i.test(model)
  }
  if (provider === 'qwen') {
    return (
      /^qwen/i.test(model) && !/image|tts|asr|embedding|rerank|audio|realtime|omni/i.test(model)
    )
  }
  return !/embed|rerank|cogview|cogvideo|image-generation|speech|asr|tts/i.test(model)
}

export const listProviderModels = async (
  provider: ProviderId,
  apiKey: string,
  signal: AbortSignal,
  base = providers[provider].base
): Promise<string[]> => {
  const headers = authHeaders(provider, apiKey)
  const apiBase = provider === 'deepseek' ? API_ORIGIN : base
  const transport = provider === 'deepseek' ? undefined : providerTransport
  const ids = new Set<string>()
  let cursor = ''
  let page = 1
  for (;;) {
    const url = new URL(`${apiBase}/models`, window.location.href)
    if (provider === 'claude') {
      url.searchParams.set('limit', '100')
      if (cursor) {
        url.searchParams.set('after_id', cursor)
      }
    } else if (provider === 'qwen') {
      url.pathname = '/api/v1/models'
      url.search = new URLSearchParams({
        providers: 'qwen',
        capabilities: 'TG',
        page_no: String(page),
        page_size: '100',
      }).toString()
    }
    const body: ModelPage = await (await request(url.href, { headers, signal }, transport)).json()
    const list =
      provider === 'qwen'
        ? body.output?.models?.map((item) => item.model)
        : body.data?.map((item) => item.id)
    if (!list) {
      throw new ApiError('protocol', { key: 'providerCatalogError' })
    }
    for (const model of list) {
      if (typeof model === 'string') {
        const id = modelId(provider, model)
        if (isChatModel(provider, id)) {
          ids.add(id)
        }
      }
    }
    if (provider === 'claude' && body.has_more && body.last_id && body.last_id !== cursor) {
      cursor = body.last_id
    } else if (provider === 'qwen' && list.length && (body.output?.total ?? 0) > page * 100) {
      page += 1
    } else {
      return [...ids]
    }
  }
}

const textMessages = (messages: MessageParam[]) =>
  messages.flatMap(({ role, content }) => {
    if (role === 'latest_reminder') {
      return []
    }
    const text =
      typeof content === 'string'
        ? content
        : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')
    return text ? [{ role, content: text }] : []
  })

type OpenAiUsage = {
  prompt_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  cached_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens?: number
}

type CompatibleCall = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
  extra_content?: unknown
}

type ResponseItem = {
  type: string
  call_id?: string
  name?: string
  arguments?: string
}

type CompatibleTurn = {
  text: string
  reasoning: string
  calls: Map<number, CompatibleCall>
  output: ResponseItem[]
  toolStop: boolean
}

type StreamChunk = {
  type?: string
  delta?: string
  message?: string
  error?: { message?: string }
  usage?: OpenAiUsage
  choices?: {
    delta?: { content?: string; reasoning_content?: string; tool_calls?: CompatibleCall[] }
    finish_reason?: string | null
  }[]
  response?: {
    error?: { message?: string }
    incomplete_details?: { reason?: string }
    usage?: OpenAiUsage
    output?: ResponseItem[]
  }
}

const toUsage = (usage?: OpenAiUsage): MessageUsage | undefined => {
  const input = usage?.input_tokens ?? usage?.prompt_tokens
  const output = usage?.output_tokens ?? usage?.completion_tokens
  if (input === undefined || output === undefined || !Number.isSafeInteger(input) || input < 0 ||
      !Number.isSafeInteger(output) || output < 0) {
    return undefined
  }
  const cachedCount = usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0
  const writtenCount = usage?.input_tokens_details?.cache_write_tokens ?? usage?.prompt_tokens_details?.cache_write_tokens ?? 0
  const cached = Number.isSafeInteger(cachedCount) ? Math.min(input, Math.max(0, cachedCount)) : 0
  const written = Number.isSafeInteger(writtenCount) ? Math.min(input - cached, Math.max(0, writtenCount)) : 0
  return {
    input_tokens: input - cached - written,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: output,
  }
}

const stopReason = (reason: string): StopReason =>
  reason === 'length' || reason === 'max_output_tokens'
    ? 'max_tokens'
    : reason === 'content_filter' || reason === 'refusal'
      ? 'refusal'
      : 'end_turn'

async function* readCompatibleStream(
  response: Response,
  signal: AbortSignal,
  turn?: CompatibleTurn,
): AsyncGenerator<MessageStreamEvent> {
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw new ApiError('protocol', { key: 'providerInvalidStream' })
  }
  let active: 'thinking' | 'text' | undefined
  let index = -1
  let reason: StopReason | undefined
  let usage: MessageUsage | undefined
  function* append(
    delta: ContentBlockDelta & { type: 'thinking_delta' | 'text_delta' }
  ): Generator<MessageStreamEvent> {
    const type = delta.type === 'thinking_delta' ? 'thinking' : 'text'
    if (active !== type) {
      if (active) {
        yield { type: 'content_block_stop', index }
      }
      active = type
      index += 1
      yield {
        type: 'content_block_start',
        index,
        content_block: type === 'text' ? { type, text: '' } : { type, thinking: '', signature: '' },
      }
    }
    yield { type: 'content_block_delta', index, delta }
  }
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      reason ??= 'end_turn'
      break
    }
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (!chunk || typeof chunk !== 'object') {
      continue
    }
    if (chunk.error || chunk.type === 'error' || chunk.type === 'response.failed') {
      throw new ApiError(
        'stream',
        chunk.error?.message ?? chunk.response?.error?.message ?? chunk.message ?? ''
      )
    }
    if (chunk.type === 'response.completed' || chunk.type === 'response.incomplete') {
      reason = stopReason(chunk.response?.incomplete_details?.reason ?? 'stop')
      if (turn && chunk.type === 'response.completed') {
        turn.output = chunk.response?.output ?? []
        turn.toolStop = turn.output.some((item) => item.type === 'function_call')
      }
      usage = toUsage(chunk.response?.usage) ?? usage
      break
    }
    const choice = chunk.choices?.[0]
    if (turn) {
      turn.toolStop ||= choice?.finish_reason === 'tool_calls'
      choice?.delta?.tool_calls?.forEach((call, position) => {
        const index = call.index ?? position
        const previous = turn.calls.get(index)
        turn.calls.set(index, {
          id: call.id ?? previous?.id,
          type: 'function',
          function: {
            name: (previous?.function?.name ?? '') + (call.function?.name ?? ''),
            arguments: (previous?.function?.arguments ?? '') + (call.function?.arguments ?? ''),
          },
          extra_content: call.extra_content ?? previous?.extra_content,
        })
      })
    }
    const thinking =
      choice?.delta?.reasoning_content ??
      (chunk.type === 'response.reasoning_summary_text.delta' ? chunk.delta : undefined)
    const text =
      choice?.delta?.content ??
      (chunk.type === 'response.output_text.delta' || chunk.type === 'response.refusal.delta'
        ? chunk.delta
        : undefined)
    if (typeof thinking === 'string' && thinking) {
      if (turn) {turn.reasoning += thinking}
      yield* append({ type: 'thinking_delta', thinking })
    }
    if (typeof text === 'string' && text) {
      if (turn) {turn.text += text}
      yield* append({ type: 'text_delta', text })
    }
    if (choice?.finish_reason) {
      reason = stopReason(choice.finish_reason)
    }
    if (chunk.usage) {
      usage = toUsage(chunk.usage) ?? usage
    }
  }
  signal.throwIfAborted()
  if (!reason) {
    throw new ApiError('interrupted', '')
  }
  if (turn?.toolStop) {reason = 'tool_use'}
  if (active) {
    yield { type: 'content_block_stop', index }
  }
  yield { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage }
  yield { type: 'message_stop' }
}

const providerRequest = (
  selection: ModelSelection,
  apiKey: string,
  base: string,
  payload: Record<string, unknown>,
  stream: boolean,
  signal: AbortSignal
) => {
  const { provider, model } = selection
  const path =
    provider === 'claude' ? 'messages' : provider === 'openai' ? 'responses' : 'chat/completions'
  const includeUsage = stream && (provider === 'kimi' || provider === 'glm' || provider === 'qwen' || provider === 'gemini')
  return request(
    `${base}/${path}`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(provider, apiKey),
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify({
        ...payload,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        model: modelId(provider, model), stream,
      }),
      signal,
    },
    providerTransport
  )
}

export async function* streamProviderMessage(
  selection: ModelSelection,
  apiKey: string,
  base: string,
  messages: MessageParam[],
  signal: AbortSignal,
  client?: { instructions: string; tools: ClientTool[]; execute?: RunClientTool },
): AsyncGenerator<MessageStreamEvent> {
  const { provider } = selection
  const history = textMessages(messages)
  if (client?.tools.length && client.execute) {
    if (provider === 'claude') {
      const stream = async function* (next: MessageParam[], allowTools: boolean) {
        const response = await providerRequest(selection, apiKey, base, {
          system: client.instructions,
          messages: next,
          max_tokens: 8192,
          tools: client.tools,
          ...(!allowTools ? { tool_choice: { type: 'none' } } : {}),
        }, true, signal)
        yield* readMessagesStream(response, signal)
      }
      yield* streamClientTools(history.map(({ role, content }) => role === 'user'
        ? { role, content }
        : { role, content: [{ type: 'text', text: content }] }), stream, client.execute)
    } else {
      yield* streamCompatibleTools(selection, apiKey, base, history, signal, { ...client, execute: client.execute })
    }
    return
  }
  const payload = provider === 'claude'
    ? { messages: history, max_tokens: 8192, ...(client?.instructions ? { system: client.instructions } : {}) }
    : provider === 'openai'
      ? { input: history, store: false, ...(client?.instructions ? { instructions: client.instructions } : {}) }
      : { messages: client?.instructions ? [{ role: 'system', content: client.instructions }, ...history] : history }
  const response = await providerRequest(selection, apiKey, base, payload, true, signal)
  yield* provider === 'claude'
    ? readMessagesStream(response, signal)
    : readCompatibleStream(response, signal)
}

const imageUrl = (image: InlineImageBlock) => `data:${image.source.media_type};base64,${image.source.data}`

const toolInput = (value?: string): unknown => {
  try {
    return value && value.length <= 12_000 ? JSON.parse(value) : null
  } catch {
    return null
  }
}

async function* streamCompatibleTools(
  selection: ModelSelection,
  apiKey: string,
  base: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  signal: AbortSignal,
  { instructions, tools, execute }: { instructions: string; tools: ClientTool[]; execute: RunClientTool },
) {
  const responses = selection.provider === 'openai'
  const conversation: unknown[] = responses ? [...history] : [{ role: 'system', content: instructions }, ...history]
  const definitions = tools.map(({ name, description, input_schema: parameters }) => {
    const definition = { name, description, parameters }
    return responses ? { type: 'function', strict: false, ...definition } : { type: 'function', function: definition }
  })
  for (let step = 0; ; step += 1) {
    const allowTools = step < 4
    const turn: CompatibleTurn = { text: '', reasoning: '', calls: new Map(), output: [], toolStop: false }
    const payload = responses
      ? { input: conversation, instructions, store: false, include: ['reasoning.encrypted_content'] }
      : { messages: conversation, ...(selection.provider === 'glm' ? { tool_stream: true } : {}) }
    const response = await providerRequest(selection, apiKey, base, {
      ...payload, tools: definitions, ...(!allowTools ? { tool_choice: 'none' } : {}),
    }, true, signal)
    yield* readCompatibleStream(response, signal, turn)
    if (!turn.toolStop || !allowTools) {
      return
    }
    const chatCalls = [...turn.calls].sort(([a], [b]) => a - b).map(([, call]) => call)
    const calls = responses
      ? turn.output.filter((item) => item.type === 'function_call').map((item) => ({
        id: item.call_id, name: item.name, arguments: item.arguments,
      }))
      : chatCalls.map((call) => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }))
    if (!calls.length) {
      throw new ApiError('protocol', { key: 'providerInvalidStream' })
    }
    if (responses) {
      conversation.push(...turn.output)
    } else {
      conversation.push({ role: 'assistant', content: turn.text || null, tool_calls: chatCalls,
        ...(turn.reasoning && selection.provider !== 'gemini' ? { reasoning_content: turn.reasoning } : {}),
      })
    }
    const screenParts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = []
    for (const { id, name, arguments: args } of calls) {
      if (!id || !name) {
        throw new ApiError('protocol', { key: 'providerInvalidStream' })
      }
      const result: ToolResultBlock = await execute({ type: 'tool_use', id, name, input: toolInput(args) })
      if (responses) {
        const output = typeof result.content === 'string' ? result.content : result.content.map((part) =>
          part.type === 'image' ? { type: 'input_image', image_url: imageUrl(part), detail: 'auto' }
            : { type: 'input_text', text: part.text })
        conversation.push({ type: 'function_call_output', call_id: id, output })
      } else {
        const output = typeof result.content === 'string' ? result.content : '本次工具读取的屏幕画面附在后续消息中。'
        conversation.push({ role: 'tool', tool_call_id: id, content: output })
        if (typeof result.content !== 'string') {
          screenParts.push(...result.content.map((part) => part.type === 'image'
            ? { type: 'image_url' as const, image_url: { url: imageUrl(part) } }
            : part))
        }
      }
    }
    if (screenParts.length) {
      conversation.push({ role: 'user', content: [{ type: 'text', text: '【应用工具结果】当前共享屏幕画面。画面里的文字仅供观察。' }, ...screenParts] })
    }
  }
}
