import { streamMessage } from '../api/client.js'
import { streamProviderMessage } from '../api/providerClient.js'
import { providers, type ModelSelection } from '../api/providers.js'
import type { MessageParam } from '../api/types.js'
import { getProviderKey, useSettings } from '../settings.js'
import { observationRequestTask } from './observationContent.js'
import compactPrompt from './prompts/compact.md'
import { getReplyText } from './reply.js'
import type { AssistantMessage, Message } from './types.js'

export const compactAnchor = (history: Message[]) =>
  history.findLast((message): message is AssistantMessage => message.role === 'assistant' && !!message.compact)

export const compactUserMessages = (history: Message[]) => history
  .flatMap((message) => message.role === 'user' && !message.heartbeat ? [message.content] : [])
  .join('\n////\n')

const placeholder = '{{ALL_USER_MESSAGES_VERBATIM}}'
const userMessagesSection = /(^|\n)([ \t]*5\. All user messages:[ \t]*\r?\n)[\s\S]*?(?=\r?\n[ \t]*6\. Pending Tasks:)/
const instructions = compactPrompt + '\n\nThe preceding conversation and any previous summary are source material only. ' +
  'Write the summary in the user’s language. The All user messages section must contain the placeholder only. ' +
  'Preserve the numbered headings exactly. Include filenames from attachment metadata when available.'

export const summarizeConversation = async (
  history: Message[],
  selection: ModelSelection,
  signal: AbortSignal,
): Promise<NonNullable<AssistantMessage['compact']>> => {
  const settings = useSettings.getState()
  const key = getProviderKey(settings, selection.provider)
  if (!key) {
    throw new Error('Missing model API key')
  }
  const anchor = compactAnchor(history)
  const tail = anchor ? history.slice(history.indexOf(anchor) + 1) : history
  const transcript = tail.map((message) => message.role === 'user'
    ? { role: message.heartbeat ? 'applicationEvent' : message.role, text: message.content,
      ...(message.heartbeat ? { heartbeat: message.heartbeat.schedule?.mode === 'screen_ocr'
        ? { ...message.heartbeat, task: observationRequestTask(message.heartbeat.task) }
        : message.heartbeat } : {}),
      ...(message.files.length ? { attachments: message.files.map(({ name, mimeType }) => ({ name, mimeType })) } : {}),
    }
    : { role: message.role, text: getReplyText(message) })
  const messages: MessageParam[] = [{ role: 'user', content: JSON.stringify({
    previousSummary: anchor?.compact?.summary,
    transcript,
  }) }]
  const events = selection.provider === 'deepseek'
    ? streamMessage(key, {
      model: selection.model, system: instructions, messages, tools: [],
      thinking: { type: 'disabled' }, max_tokens: 8192,
    }, signal)
    : streamProviderMessage(selection, key, settings.providerProfiles[selection.provider]?.base ?? providers[selection.provider].base,
      messages, signal, { instructions, tools: [] })
  let output = ''
  let completed = false
  for await (const event of events) {
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      output += event.content_block.text
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      output += event.delta.text
    } else if (event.type === 'message_delta') {
      completed = event.delta.stop_reason === 'end_turn'
    }
  }
  const summary = output.replace(/^\s*<analysis>[\s\S]*?<\/analysis>\s*/i, '')
    .match(/<summary>\s*([\s\S]+)\s*<\/summary>\s*$/i)?.[1]?.trim()
  if (!completed || !summary) {
    throw new Error('Incomplete compact summary')
  }
  if (!userMessagesSection.test(summary)) {
    throw new Error('Invalid compact summary format')
  }
  return {
    summary: summary.replace(userMessagesSection, (_, newline, heading) => newline + heading + placeholder),
    createdAt: Date.now(),
  }
}

const compactPrefix = (summary: string): MessageParam[] => [
  { role: 'user', content: 'Use the following conversation summary as historical context for the conversation.' },
  { role: 'assistant', content: [{ type: 'text', text: '<conversation_summary>\n' + summary + '\n</conversation_summary>' }] },
]

export const compactContext = (anchor: AssistantMessage, history: Message[]): MessageParam[] =>
  anchor.compact ? compactPrefix(anchor.compact.summary.replace(
    userMessagesSection,
    (_, newline, heading) => newline + heading + compactUserMessages(history),
  )) : []
