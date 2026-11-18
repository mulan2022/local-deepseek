import type { MessageUsage } from '../api/types.js'

export const inputTokens = (usage: MessageUsage) =>
  usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens

export const totalTokens = (usage: MessageUsage) => inputTokens(usage) + usage.output_tokens

export const addUsage = (total: MessageUsage | undefined, next: MessageUsage): MessageUsage =>
  total ? {
    input_tokens: total.input_tokens + next.input_tokens,
    cache_creation_input_tokens: total.cache_creation_input_tokens + next.cache_creation_input_tokens,
    cache_read_input_tokens: total.cache_read_input_tokens + next.cache_read_input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
  } : next
