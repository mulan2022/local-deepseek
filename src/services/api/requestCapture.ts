export type RequestPayload = {
  id: string
  journalId: string
  sessionId: string
  encoding: 'json' | 'gzip'
  body: Blob
  characters: number
}

export type CapturedRequest = {
  id: string
  at: number
  url: string
  method: string
  headers: Record<string, string>
  httpStatus?: number
  outcome: 'pending' | 'response' | 'network_error'
  payloadAvailable: boolean
}

export type RequestJournal = {
  version: 1
  runId: string
  id: string
  sessionId: string
  messageId: string
  state: 'recording' | 'complete' | 'partial'
  createdAt: number
  updatedAt: number
  replyStatus?: string
  requests: CapturedRequest[]
}

type RequestObserver = (value: {
  at: number; url: string; method: string; headers: Record<string, string>; body: string
}) => (status?: number) => void
const observers = new WeakMap<AbortSignal, RequestObserver>()

export const requestJournalId = (sessionId: string, messageId: string) => JSON.stringify([sessionId, messageId])
export const observeRequests = (signal: AbortSignal, observer: RequestObserver) => {
  observers.set(signal, observer)
  return () => observers.delete(signal)
}

/** Observe the final serialized body before transport; never record authentication headers. */
export const captureRequest = (url: string, init: RequestInit) => {
  const observer = init.signal ? observers.get(init.signal) : undefined
  if (!observer || typeof init.body !== 'string' || (init.method ?? 'GET').toUpperCase() !== 'POST') { return }
  const source = new Headers(init.headers)
  if (!source.get('content-type')?.includes('application/json')) { return }
  const headers: Record<string, string> = {}
  for (const [name, value] of source.entries()) {
    if (!/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|api_key|apikey|x-goog-api-key|(?:x-)?(?:auth|access|refresh)[-_]token)$/i.test(name)) {
      headers[name] = value
    }
  }
  const endpoint = new URL(url, window.location.href)
  endpoint.username = ''
  endpoint.password = ''
  for (const name of [...endpoint.searchParams.keys()]) {
    if (/key|token|auth|signature|secret/i.test(name)) { endpoint.searchParams.delete(name) }
  }
  return observer({ at: Date.now(), url: endpoint.href, method: 'POST', headers, body: init.body })
}

export const encodeRequestPayload = async (
  value: string, info: Pick<RequestPayload, 'id' | 'journalId' | 'sessionId'>,
): Promise<RequestPayload> => {
  const raw = new Blob([value], { type: 'application/json' })
  if (typeof CompressionStream !== 'undefined') {
    try {
      const compressed = await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob()
      if (compressed.size < raw.size) {
        return { ...info, characters: value.length, encoding: 'gzip', body: compressed }
      }
    } catch { /* A plain JSON Blob preserves the exact request when compression is unavailable. */ }
  }
  return { ...info, characters: value.length, encoding: 'json', body: raw }
}

export const decodeRequestPayload = async (payload: Pick<RequestPayload, 'encoding' | 'body'>) => {
  if (payload.encoding === 'json') { return payload.body.text() }
  if (typeof DecompressionStream !== 'undefined') {
    return new Response(payload.body.stream().pipeThrough(new DecompressionStream('gzip'))).text()
  }
  const { gunzipSync, strFromU8 } = await import('fflate')
  return strFromU8(gunzipSync(new Uint8Array(await payload.body.arrayBuffer())))
}
