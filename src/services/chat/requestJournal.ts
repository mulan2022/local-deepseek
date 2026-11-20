import { createId } from '../../utils/id.js'
import { encodeRequestPayload, observeRequests, requestJournalId, type CapturedRequest, type RequestJournal } from '../api/requestCapture.js'
import * as db from './db.js'

/** Scoped to one reply, including tool turns, retries and helper model requests using its signal. */
export const beginRequestJournal = (folderId: string, sessionId: string, messageId: string, signal: AbortSignal, append = false) => {
  const id = requestJournalId(sessionId, messageId)
  const runId = createId()
  let failed = false
  let journal: RequestJournal = {
    version: 1, runId, id, sessionId, messageId, state: 'recording',
    createdAt: Date.now(), updatedAt: Date.now(), requests: [],
  }
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (action: () => Promise<void>) => {
    queue = queue.then(action).catch(error => {
      failed = true
      db.reportStorageError('record model request')(error)
    })
  }
  enqueue(async () => {
    if (append) {
      const previous = await db.loadRequestJournal(folderId, id)
      if (previous) {
        failed = previous.state !== 'complete'
        journal = { ...previous, runId, state: 'recording', updatedAt: Date.now() }
      } else { failed = true }
    } else { await db.deleteRequestJournal(folderId, id) }
    await db.saveRequestJournal(folderId, journal)
  })
  const stop = observeRequests(signal, request => {
    const entry: CapturedRequest = {
      id: createId(), at: request.at, url: request.url, method: request.method,
      headers: request.headers, outcome: 'pending', payloadAvailable: false,
    }
    // Start compression while the remote model runs; queue writes in actual request order.
    const payload = encodeRequestPayload(request.body, { id: entry.id, journalId: id, sessionId })
    // Attach a rejection handler immediately even if an earlier write is still pending.
    const ready = payload.then(value => ({ value }), error => ({ error }))
    enqueue(async () => {
      journal.requests.push(entry)
      const result = await ready
      if (!('value' in result)) { throw result.error }
      entry.payloadAvailable = true
      journal.updatedAt = Date.now()
      try { await db.saveCapturedRequest(folderId, journal, result.value) }
      catch (error) { entry.payloadAvailable = false; throw error }
    })
    return status => {
      entry.outcome = status === undefined ? 'network_error' : 'response'
      if (status !== undefined) { entry.httpStatus = status }
    }
  })
  return {
    runId,
    finish: async (replyStatus: string) => {
      stop()
      await queue
      journal = { ...journal, replyStatus, state: failed ? 'partial' : 'complete', updatedAt: Date.now() }
      try { await db.saveRequestJournal(folderId, journal) }
      catch (error) { failed = true; db.reportStorageError('finish model request recording')(error) }
      return failed ? 'partial' as const : 'complete' as const
    },
  }
}
