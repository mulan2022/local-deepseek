import { translate } from '../../i18n/index.js'
import { API_ORIGIN, ApiError, request } from './client.js'
import type { ClientTool, ToolResultBlock, ToolUseBlock } from './types.js'

const RESULT_COUNT = 5
const MAX_PAGE_CHARACTERS = 16_000

const searchTool: ClientTool = {
  name: 'web_search',
  description: 'Search the public web for current or verifiable information. Returns titles, URLs, and excerpts. Formulate the search terms yourself.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search terms, 1–128 Unicode characters.' } },
    required: ['query'],
    additionalProperties: false,
  },
}

const fetchTool: ClientTool = {
  name: 'web_fetch',
  description: 'Read a public webpage from an HTTP or HTTPS URL, such as a link provided by the user or a search result. Returns Markdown.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Complete HTTP or HTTPS URL without credentials.' } },
    required: ['url'],
    additionalProperties: false,
  },
}

export const webTools = [searchTool, fetchTool]

const isWebUrl = (value: string) => {
  if (value.length > 8192 || !/^https?:\/\//i.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

const toSearchResult = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('url' in value) ||
      typeof value.url !== 'string' || !isWebUrl(value.url)) {
    return []
  }
  const title = 'title' in value && typeof value.title === 'string' ? value.title.slice(0, 300) : ''
  const summary = 'summary' in value && typeof value.summary === 'string' ? value.summary.trim() : ''
  const snippet = 'snippet' in value && typeof value.snippet === 'string' ? value.snippet : ''
  const date = 'date' in value && typeof value.date === 'string' ? value.date : undefined
  return [{ title, url: value.url, summary: (summary || snippet).slice(0, 1000), date }]
}

export const createWebToolRunner = (apiKey: string, signal: AbortSignal) => {
  const completed = new Map<string, string>()
  return async ({ id, name, input }: ToolUseBlock): Promise<ToolResultBlock> => {
    const result = (content: string, isError = false): ToolResultBlock =>
      ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) })
    const failure = (message: string, status?: number) =>
      result(JSON.stringify({ ok: false, error: message, status }), true)
    if (!apiKey) {
      return failure(translate('webSearchMissingKey'))
    }

    const search = name === searchTool.name
    const args = input as { query?: unknown; url?: unknown } | null
    const value = search ? args?.query : args?.url
    const target = typeof value === 'string' ? value.trim() : ''
    if (search ? !target || Array.from(target).length > 128 : name !== fetchTool.name || !isWebUrl(target)) {
      return failure(translate(search ? 'webSearchInvalidQuery' : 'webFetchInvalidUrl'))
    }

    signal.throwIfAborted()
    const cacheKey = JSON.stringify([name, target])
    const cached = completed.get(cacheKey)
    if (cached !== undefined) {
      return result(cached)
    }

    try {
      const response = await request(`${API_ORIGIN}/v1/tools/${search ? 'search' : 'fetch'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(search ? { query: target, count: RESULT_COUNT } : { url: target }),
        credentials: 'omit',
        redirect: 'error',
        signal,
      })
      const body: unknown = await response.json()
      signal.throwIfAborted()
      if (!body || typeof body !== 'object') {
        return failure(translate('webSearchInvalidResponse'))
      }
      let content: string
      if (search && 'results' in body && Array.isArray(body.results)) {
        content = JSON.stringify({ ok: true, query: target, results: body.results.slice(0, RESULT_COUNT).flatMap(toSearchResult) })
      } else if (!search && 'title' in body && typeof body.title === 'string' && 'content' in body && typeof body.content === 'string') {
        content = JSON.stringify({
          ok: true, url: target, title: body.title.slice(0, 300), content: body.content.slice(0, MAX_PAGE_CHARACTERS),
          truncated: body.content.length > MAX_PAGE_CHARACTERS,
        })
      } else {
        return failure(translate('webSearchInvalidResponse'))
      }
      completed.set(cacheKey, content)
      return result(content)
    } catch (error) {
      signal.throwIfAborted()
      const status = error instanceof ApiError ? error.status : undefined
      if (status === 401) {
        return failure(translate('webSearchInvalidKey'), status)
      }
      return failure(translate(search ? 'webSearchFailed' : 'webFetchFailed'), status)
    }
  }
}
