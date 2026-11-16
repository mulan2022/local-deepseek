const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const SOURCE = `(?:session-)?${UUID}:(?:${UUID}|[0-9]+)`
const sourcePattern = new RegExp(`[ \\t]*(?:\\[\\^?(${SOURCE})\\]|\\b(${SOURCE})\\b)`, 'gi')

export const splitMemorySources = (value: string) => {
  const sources = new Set<string>()
  const text = value.replace(sourcePattern, (_match, bracketed: string | undefined, bare: string) => {
    sources.add(bracketed ?? bare)
    return ''
  })
  return { text, sources: [...sources] }
}

/** Conversation and displayed memory use prose. Tool search keeps the original evidence fields. */
export const withoutMemorySources = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return splitMemorySources(value).text
  }
  if (Array.isArray(value)) {
    return value.map(withoutMemorySources)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'source' && key !== 'sources' && key !== 'sectionSources')
      .map(([key, entry]) => [key, withoutMemorySources(entry)]))
  }
  return value
}

/** Only migrate generated memory fields in old frames. Keep historical excerpts byte-for-byte. */
export const publicMemoryPayload = (payload: string): string => {
  try {
    const frame = JSON.parse(payload)
    if (!frame || typeof frame !== 'object') {
      return payload
    }
    let changed = false
    for (const key of ['vault', 'entities', 'toolResults', 'pinned', 'sections'] as const) {
      if (Object.hasOwn(frame, key)) {
        const publicValue = withoutMemorySources(frame[key])
        if (JSON.stringify(publicValue) !== JSON.stringify(frame[key])) {
          frame[key] = publicValue
          changed = true
        }
      }
    }
    return changed ? JSON.stringify(frame) : payload
  } catch {
    return payload
  }
}
