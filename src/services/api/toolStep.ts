import type { AssistantBlockParam, MessageParam, MessageStreamEvent, ToolResultBlock, ToolUseBlock } from './types.js'

type ToolBlock = { block: AssistantBlockParam; json: string; overflow?: boolean }

const completedBlock = (entry: ToolBlock): AssistantBlockParam => {
  if (entry.block.type !== 'tool_use') {
    return entry.block
  }
  const { block } = entry
  let input: unknown = block.input ?? {}
  try {
    if (entry.json && !entry.overflow) {
      input = JSON.parse(entry.json)
    } else if (entry.overflow) {
      input = {}
    }
  } catch {
    input = {}
  }
  return { ...block, input }
}

const collectToolStep = async function* (events: AsyncIterable<MessageStreamEvent>) {
  const blocks = new Map<number, ToolBlock>()
  let toolStop = false
  for await (const event of events) {
    yield event
    if (event.type === 'message_delta') {
      toolStop = event.delta.stop_reason === 'tool_use'
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block
      blocks.set(event.index, { block: { ...block }, json: '' })
    }
    if (event.type === 'content_block_delta') {
      const entry = blocks.get(event.index)
      const { delta } = event
      if (entry?.block.type === 'tool_use' && delta.type === 'input_json_delta') {
        entry.json += delta.partial_json
        if (entry.json.length > 12_000) {
          entry.overflow = true
          entry.json = ''
        }
      } else if (entry?.block.type === 'text' && delta.type === 'text_delta') {
        entry.block.text += delta.text
      } else if (entry?.block.type === 'thinking' && delta.type === 'thinking_delta') {
        entry.block.thinking += delta.thinking
      } else if (entry?.block.type === 'thinking' && delta.type === 'signature_delta') {
        entry.block.signature = (entry.block.signature ?? '') + delta.signature
      }
    }
  }
  return { toolStop, blocks: [...blocks].sort(([a], [b]) => a - b).map(([, item]) => completedBlock(item)) }
}

export type RunClientTool = (call: ToolUseBlock) => Promise<ToolResultBlock>

export async function* streamClientTools(
  history: MessageParam[],
  stream: (messages: MessageParam[], allowTools: boolean) => AsyncIterable<MessageStreamEvent>,
  execute: RunClientTool,
) {
  const messages = [...history]
  for (let step = 0; ; step += 1) {
    const allowTools = step < 4
    const { blocks, toolStop } = yield* collectToolStep(stream(messages, allowTools))
    const calls = blocks.filter((block) => block.type === 'tool_use')
    if (!toolStop || !calls.length || !allowTools) {
      return
    }
    const results = []
    for (const call of calls) {
      results.push(await execute(call))
    }
    messages.push({ role: 'assistant', content: blocks }, { role: 'user', content: results })
  }
}
