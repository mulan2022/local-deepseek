import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  DEFAULT_FOLDER_ID,
  DEFAULT_FOLDER_NAME,
  toSessionSummary,
  type ChatFolder,
  type Session,
  type SessionSummary,
} from './types.js'
import { favoriteId, type FavoriteSnapshot, type FavoriteSummary } from './favoriteTypes.js'
import { requestJournalId, type RequestJournal, type RequestPayload } from '../api/requestCapture.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 14

/** 文件原件按 [folderId, id] 存储，同一文件夹内引用同一 id 的消息共用一份。 */
export type StoredFile = {
  id: string
  folderId: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }
type StoredRequestJournal = RequestJournal & { folderId: string }
type StoredRequestPayload = RequestPayload & { folderId: string }
type FolderKey = [string, string]

interface ChatDB extends DBSchema {
  folders: { key: string; value: ChatFolder }
  requestJournals: {
    key: FolderKey
    value: StoredRequestJournal
    indexes: { folderId: string; sessionId: string; folderSession: FolderKey }
  }
  requestPayloads: {
    key: FolderKey
    value: StoredRequestPayload
    indexes: {
      folderId: string
      sessionId: string
      journalId: string
      folderSession: FolderKey
      folderJournal: FolderKey
    }
  }
  favorites: { key: string; value: FavoriteSummary }
  favoriteSnapshots: { key: string; value: FavoriteSnapshot }
  sessions: { key: FolderKey; value: Session; indexes: { folderId: string } }
  sessionSummaries: {
    key: FolderKey
    value: StoredSessionSummary
    indexes: { folderId: string; fileIds: string }
  }
  files: { key: FolderKey; value: StoredFile; indexes: { folderId: string } }
  /** 历史导入按文件夹暂存，提交时只替换目标文件夹的正式数据。 */
  sessionsStaging: { key: FolderKey; value: Session; indexes: { folderId: string } }
  filesStaging: { key: FolderKey; value: StoredFile; indexes: { folderId: string } }
}

type LegacySession = Omit<Session, 'folderId'> & { folderId?: string }
type LegacySummary = Omit<StoredSessionSummary, 'folderId'> & { folderId?: string }
type LegacyFile = Omit<StoredFile, 'folderId'> & { folderId?: string }
type LegacyJournal = Omit<StoredRequestJournal, 'folderId'> & { folderId?: string }
type LegacyPayload = Omit<StoredRequestPayload, 'folderId'> & { folderId?: string }
type LegacyFavorite = Omit<FavoriteSummary, 'sourceFolderId'>
type LegacyFavoriteSnapshot = Omit<FavoriteSnapshot, 'session'> & { session: LegacySession }

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    async upgrade(db, _oldVersion, _newVersion, tx) {
      type StoreName =
        | 'folders' | 'sessions' | 'sessionSummaries' | 'files' | 'sessionsStaging'
        | 'filesStaging' | 'requestJournals' | 'requestPayloads' | 'favorites' | 'favoriteSnapshots'
      const read = async <T>(name: StoreName): Promise<T[]> =>
        db.objectStoreNames.contains(name)
          ? await tx.objectStore(name).getAll() as T[]
          : []
      // 主键变更必须重建存储；先把旧记录（包括 Blob）全部读出，再在同一事务中写回。
      const [
        sessions, summaries, files, stagingSessions, stagingFiles, journals, payloads,
        favoriteItems, favoriteSnapshots,
      ] = await Promise.all([
        read<LegacySession>('sessions'),
        read<LegacySummary>('sessionSummaries'),
        read<LegacyFile>('files'),
        read<LegacySession>('sessionsStaging'),
        read<LegacyFile>('filesStaging'),
        read<LegacyJournal>('requestJournals'),
        read<LegacyPayload>('requestPayloads'),
        read<LegacyFavorite>('favorites'),
        read<LegacyFavoriteSnapshot>('favoriteSnapshots'),
      ])
      for (const name of [
        'sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging',
        'requestJournals', 'requestPayloads',
      ] as const) {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name)
        }
      }

      const sessionStore = db.createObjectStore('sessions', { keyPath: ['folderId', 'id'] })
      sessionStore.createIndex('folderId', 'folderId')
      const summaryStore = db.createObjectStore('sessionSummaries', { keyPath: ['folderId', 'id'] })
      summaryStore.createIndex('folderId', 'folderId')
      summaryStore.createIndex('fileIds', 'fileIds', { multiEntry: true })
      const fileStore = db.createObjectStore('files', { keyPath: ['folderId', 'id'] })
      fileStore.createIndex('folderId', 'folderId')
      const stagingSessionStore = db.createObjectStore('sessionsStaging', { keyPath: ['folderId', 'id'] })
      stagingSessionStore.createIndex('folderId', 'folderId')
      const stagingFileStore = db.createObjectStore('filesStaging', { keyPath: ['folderId', 'id'] })
      stagingFileStore.createIndex('folderId', 'folderId')
      const journalStore = db.createObjectStore('requestJournals', { keyPath: ['folderId', 'id'] })
      journalStore.createIndex('folderId', 'folderId')
      journalStore.createIndex('sessionId', 'sessionId')
      journalStore.createIndex('folderSession', ['folderId', 'sessionId'])
      const payloadStore = db.createObjectStore('requestPayloads', { keyPath: ['folderId', 'id'] })
      payloadStore.createIndex('folderId', 'folderId')
      payloadStore.createIndex('sessionId', 'sessionId')
      payloadStore.createIndex('journalId', 'journalId')
      payloadStore.createIndex('folderSession', ['folderId', 'sessionId'])
      payloadStore.createIndex('folderJournal', ['folderId', 'journalId'])

      const folderStore = db.objectStoreNames.contains('folders')
        ? tx.objectStore('folders')
        : db.createObjectStore('folders', { keyPath: 'id' })
      const now = Date.now()
      if (!(await folderStore.get(DEFAULT_FOLDER_ID))) {
        await folderStore.put({
          id: DEFAULT_FOLDER_ID,
          name: DEFAULT_FOLDER_NAME,
          createdAt: now,
          updatedAt: now,
        })
      }
      for (const session of sessions) {
        await sessionStore.put({ ...session, folderId: session.folderId ?? DEFAULT_FOLDER_ID })
      }
      for (const summary of summaries) {
        await summaryStore.put({ ...summary, folderId: summary.folderId ?? DEFAULT_FOLDER_ID })
      }
      for (const file of files) {
        await fileStore.put({ ...file, folderId: file.folderId ?? DEFAULT_FOLDER_ID })
      }
      for (const session of stagingSessions) {
        await stagingSessionStore.put({ ...session, folderId: session.folderId ?? DEFAULT_FOLDER_ID })
      }
      for (const file of stagingFiles) {
        await stagingFileStore.put({ ...file, folderId: file.folderId ?? DEFAULT_FOLDER_ID })
      }
      for (const journal of journals) {
        await journalStore.put({ ...journal, folderId: journal.folderId ?? DEFAULT_FOLDER_ID })
      }
      for (const payload of payloads) {
        await payloadStore.put({ ...payload, folderId: payload.folderId ?? DEFAULT_FOLDER_ID })
      }

      const favoriteStore = db.objectStoreNames.contains('favorites')
        ? tx.objectStore('favorites')
        : db.createObjectStore('favorites', { keyPath: 'id' })
      const snapshotStore = db.objectStoreNames.contains('favoriteSnapshots')
        ? tx.objectStore('favoriteSnapshots')
        : db.createObjectStore('favoriteSnapshots', { keyPath: 'id' })
      await Promise.all([favoriteStore.clear(), snapshotStore.clear()])
      for (const summary of favoriteItems) {
        const id = favoriteId(DEFAULT_FOLDER_ID, summary.sessionId, summary.messageId)
        await favoriteStore.put({ ...summary, id, sourceFolderId: DEFAULT_FOLDER_ID })
      }
      for (const snapshot of favoriteSnapshots) {
        const id = favoriteId(DEFAULT_FOLDER_ID, snapshot.session.id, snapshot.messageId)
        await snapshotStore.put({
          ...snapshot,
          id,
          session: { ...snapshot.session, folderId: DEFAULT_FOLDER_ID },
        })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadFolders = async (): Promise<ChatFolder[]> =>
  (await (await getDB()).getAll('folders')).sort((a, b) => a.createdAt - b.createdAt)

export const loadFolder = async (id: string): Promise<ChatFolder | undefined> =>
  (await getDB()).get('folders', id)

export const saveFolder = async (folder: ChatFolder): Promise<void> => {
  await (await getDB()).put('folders', folder)
}

export const renameFolder = async (id: string, name: string): Promise<void> => {
  const db = await getDB()
  const folder = await db.get('folders', id)
  if (folder) {
    await db.put('folders', { ...folder, name, updatedAt: Date.now() })
  }
}

/** 只删除目标文件夹及其会话数据；全局收藏和收藏快照保留。默认文件夹由上层禁止删除。 */
export const deleteFolder = async (folderId: string): Promise<void> => {
  const tx = (await getDB()).transaction([
    'folders', 'sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging',
    'requestJournals', 'requestPayloads',
  ], 'readwrite')
  const remove = async (name: 'sessions' | 'sessionSummaries' | 'files' | 'sessionsStaging' | 'filesStaging' | 'requestJournals' | 'requestPayloads') => {
    const store = tx.objectStore(name)
    for (const key of await store.index('folderId').getAllKeys(folderId)) {
      await store.delete(key)
    }
  }
  await Promise.all([
    (async () => {
      try {
        for (const name of [
          'sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging',
          'requestJournals', 'requestPayloads',
        ] as const) {
          await remove(name)
        }
        await tx.objectStore('folders').delete(folderId)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const loadSessionSummaries = async (folderId: string): Promise<SessionSummary[]> =>
  (await (await getDB()).getAllFromIndex('sessionSummaries', 'folderId', folderId)).map(toSessionSummary)

export const loadSession = async (folderId: string, id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', [folderId, id])

export const saveSession = async (
  session: Session,
  files: Omit<StoredFile, 'folderId'>[] = [],
): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put({ ...file, folderId: session.folderId })
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (folderId: string, id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get([folderId, id])
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除目标会话和请求记录，仅清理该文件夹内已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (folderId: string, sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files', 'requestJournals', 'requestPayloads'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get([folderId, sessionId])
        await tx.objectStore('sessions').delete([folderId, sessionId])
        await summaries.delete([folderId, sessionId])
        for (const id of await tx.objectStore('requestJournals').index('folderSession').getAllKeys([folderId, sessionId])) {
          await tx.objectStore('requestJournals').delete(id)
        }
        for (const id of await tx.objectStore('requestPayloads').index('folderSession').getAllKeys([folderId, sessionId])) {
          await tx.objectStore('requestPayloads').delete(id)
        }
        const remaining = await summaries.index('folderId').getAll(folderId)
        const referenced = new Set(remaining.flatMap(item => item.fileIds))
        for (const id of summary?.fileIds ?? []) {
          if (!referenced.has(id)) {
            await tx.objectStore('files').delete([folderId, id])
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (
  store: 'files' | 'filesStaging',
  folderId: string,
  files: Omit<StoredFile, 'folderId'>[],
) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put({ ...file, folderId })), tx.done])
}

export const saveFiles = (folderId: string, files: Omit<StoredFile, 'folderId'>[]): Promise<void> =>
  putFiles('files', folderId, files)

export const loadFile = async (folderId: string, id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', [folderId, id]))?.blob

export const loadFavorites = async (): Promise<FavoriteSummary[]> =>
  (await getDB()).getAll('favorites')

export const loadFavoriteSnapshot = async (id: string): Promise<FavoriteSnapshot | undefined> =>
  (await getDB()).get('favoriteSnapshots', id)

export const loadRequestJournal = async (folderId: string, id: string): Promise<RequestJournal | undefined> =>
  (await getDB()).get('requestJournals', [folderId, id])

export const saveRequestJournal = async (folderId: string, journal: RequestJournal): Promise<void> => {
  await (await getDB()).put('requestJournals', { ...journal, folderId })
}

export const saveCapturedRequest = async (
  folderId: string,
  journal: RequestJournal,
  payload: RequestPayload,
): Promise<void> => {
  const tx = (await getDB()).transaction(['requestJournals', 'requestPayloads'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        await tx.objectStore('requestJournals').put({ ...journal, folderId })
        await tx.objectStore('requestPayloads').put({ ...payload, folderId })
      } catch (error) { abortTransaction(tx); throw error }
    })(),
    tx.done,
  ])
}

export const deleteRequestJournal = async (folderId: string, id: string): Promise<void> => {
  const tx = (await getDB()).transaction(['requestJournals', 'requestPayloads'], 'readwrite')
  await Promise.all([
    (async () => {
      await tx.objectStore('requestJournals').delete([folderId, id])
      for (const key of await tx.objectStore('requestPayloads').index('folderJournal').getAllKeys([folderId, id])) {
        await tx.objectStore('requestPayloads').delete(key)
      }
    })(),
    tx.done,
  ])
}

/** Save evidence and available attachment originals atomically; folder deletion never clears these stores. */
export const saveFavorite = async (summary: FavoriteSummary, snapshot: FavoriteSnapshot): Promise<FavoriteSummary> => {
  const tx = (await getDB()).transaction(['files', 'favorites', 'favoriteSnapshots', 'requestJournals', 'requestPayloads'], 'readwrite')
  const folderId = summary.sourceFolderId
  let savedSummary = summary
  await Promise.all([
    (async () => {
      try {
        const ids = new Set(snapshot.session.messages.flatMap(message =>
          message.role === 'user' ? message.files.map(file => file.id) : []))
        const files: FavoriteSnapshot['files'] = []
        const missing: string[] = []
        for (const id of ids) {
          const file = await tx.objectStore('files').get([folderId, id])
          if (file) { files.push({ id: file.id, blob: file.blob }) } else { missing.push(id) }
        }
        const journal = await tx.objectStore('requestJournals').get([
          folderId, requestJournalId(summary.sessionId, summary.messageId),
        ])
        const answer = snapshot.session.messages.find(message => message.id === summary.messageId)
        const expected = answer?.role === 'assistant' ? answer.requestCapture : undefined
        const matches = journal?.runId === expected?.runId && !!expected
        const requests: NonNullable<FavoriteSnapshot['requestCapture']>['requests'] = []
        for (const entry of matches ? journal?.requests ?? [] : []) {
          const payload = await tx.objectStore('requestPayloads').get([folderId, entry.id])
          requests.push({ ...entry, ...(payload ? { payload: {
            encoding: payload.encoding, body: payload.body, characters: payload.characters,
          } } : {}) })
        }
        const state = !expected ? 'unavailable' : matches && expected.state === 'complete' && journal?.state === 'complete' && requests.length > 0 &&
          requests.every(entry => entry.payload && entry.payloadAvailable) ? 'complete' : 'partial'
        savedSummary = { ...summary, requestCaptureState: state, requestCount: requests.length }
        await tx.objectStore('favorites').put(savedSummary)
        await tx.objectStore('favoriteSnapshots').put({
          ...snapshot, version: 2, files, missingFileIds: missing, requestCapture: { state, requests },
        })
      } catch (error) { abortTransaction(tx); throw error }
    })(),
    tx.done,
  ])
  return savedSummary
}

export const deleteFavorite = async (id: string): Promise<void> => {
  const tx = (await getDB()).transaction(['favorites', 'favoriteSnapshots'], 'readwrite')
  await Promise.all([tx.objectStore('favorites').delete(id), tx.objectStore('favoriteSnapshots').delete(id), tx.done])
}

/** 清空目标文件夹的导入暂存，不影响其他文件夹。 */
export const clearStaging = async (folderId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  const clear = async (name: 'sessionsStaging' | 'filesStaging') => {
    const store = tx.objectStore(name)
    for (const key of await store.index('folderId').getAllKeys(folderId)) {
      await store.delete(key)
    }
  }
  await Promise.all([clear('sessionsStaging'), clear('filesStaging'), tx.done])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (
  folderId: string,
  files: Omit<StoredFile, 'folderId'>[],
): Promise<void> => putFiles('filesStaging', folderId, files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (
  folderId: string,
  types: ReadonlyMap<string, string>,
): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (
        let cursor = await tx.store.index('folderId').openCursor(folderId);
        cursor;
        cursor = await cursor.continue()
      ) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后只替换目标文件夹的会话、摘要、原件和请求留档，并清空该文件夹的暂存。
 * 逐条游标复制，事务失败时整体回滚，其他文件夹的数据不变。
 */
export const commitStaging = async (folderId: string): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', 'requestJournals', 'requestPayloads'],
    'readwrite'
  )
  const remove = async (name: 'sessions' | 'sessionSummaries' | 'files' | 'requestJournals' | 'requestPayloads') => {
    const store = tx.objectStore(name)
    for (const key of await store.index('folderId').getAllKeys(folderId)) {
      await store.delete(key)
    }
  }
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    const target = tx.objectStore(to)
    for (
      let cursor = await tx.objectStore(from).index('folderId').openCursor(folderId);
      cursor;
      cursor = await cursor.continue()
    ) {
      await target.put(cursor.value)
      if (to === 'sessions') {
        const summary = storedSummary(cursor.value as Session)
        await tx.objectStore('sessionSummaries').put(summary)
        summaries.push(toSessionSummary(summary))
      }
      await cursor.delete()
    }
  }
  try {
    await Promise.all([
      remove('sessions'), remove('sessionSummaries'), remove('files'),
      remove('requestJournals'), remove('requestPayloads'),
    ])
    await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files')])
    await tx.done
  } catch (error) {
    // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
    abortTransaction(tx)
    throw error
  }
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
