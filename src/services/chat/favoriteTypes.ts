import type { ProviderId } from '../api/providers.js'
import type { Session } from './types.js'
import type { CapturedRequest, RequestPayload } from '../api/requestCapture.js'

export type FavoriteSummary = {
  id: string
  sourceFolderId: string
  sessionId: string
  messageId: string
  sessionTitle: string
  savedAt: number
  provider: ProviderId
  model: string | null
  preview: string
  contextCount: number
  requestCaptureState?: 'complete' | 'partial' | 'unavailable'
  requestCount?: number
}

/** Raw local evidence, independent of any future training export format. No API settings are captured. */
export type FavoriteSnapshot = {
  version: 1 | 2
  id: string
  savedAt: number
  messageId: string
  likedText: string
  session: Session
  files: { id: string; blob: Blob }[]
  missingFileIds: string[]
  requestCapture?: {
    state: 'complete' | 'partial' | 'unavailable'
    requests: (CapturedRequest & { payload?: Pick<RequestPayload, 'encoding' | 'body' | 'characters'> })[]
  }
}

export const favoriteId = (folderId: string, sessionId: string, messageId: string) =>
  JSON.stringify([folderId, sessionId, messageId])
