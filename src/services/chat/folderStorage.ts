export const DEFAULT_FOLDER_ID = 'default'

const ACTIVE_FOLDER_KEY = 'chat-demo:active-folder'
const FOLDER_PREFIX = 'chat-demo:folder:'
export const CHAT_MEMORY_STORAGE_KEY = 'chat-demo:chat-memory'

/** 这些旧 key 都属于文件夹；语言、主题等全局 UI 设置不在此列表中。 */
const FOLDER_SETTINGS_KEYS = [
  'chat-demo:api-key',
  'chat-demo:selected-model',
  'chat-demo:provider-profiles',
  'chat-demo:thinking',
  'chat-demo:search',
  'chat-demo:compact',
  'chat-demo:phone-tools',
] as const
const SCOPED_KEYS = [...FOLDER_SETTINGS_KEYS, CHAT_MEMORY_STORAGE_KEY] as const

let currentFolderId = DEFAULT_FOLDER_ID

export const getActiveFolderId = () => currentFolderId

export const setActiveFolderId = (folderId: string) => {
  currentFolderId = folderId
  try {
    localStorage.setItem(ACTIVE_FOLDER_KEY, folderId)
  } catch {
    // 存储不可用时仍在当前页面内保持文件夹上下文。
  }
}

export const readActiveFolderId = () => {
  try {
    return localStorage.getItem(ACTIVE_FOLDER_KEY) ?? DEFAULT_FOLDER_ID
  } catch {
    return DEFAULT_FOLDER_ID
  }
}

export const scopedStorageKey = (folderId: string, legacyKey: string) =>
  `${FOLDER_PREFIX}${encodeURIComponent(folderId)}:${legacyKey}`

export const readFolderValue = (folderId: string, legacyKey: string) => {
  try {
    return localStorage.getItem(scopedStorageKey(folderId, legacyKey))
  } catch {
    return null
  }
}

export const writeFolderValue = (folderId: string, legacyKey: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(scopedStorageKey(folderId, legacyKey))
    } else {
      localStorage.setItem(scopedStorageKey(folderId, legacyKey), value)
    }
  } catch {
    // 存储不可用时只在内存中生效。
  }
}

/** 首次升级时复制旧配置；已存在的文件夹配置永远不被旧值覆盖。 */
export const migrateLegacyFolderStorage = () => {
  for (const key of SCOPED_KEYS) {
    try {
      const legacy = localStorage.getItem(key)
      const scoped = scopedStorageKey(DEFAULT_FOLDER_ID, key)
      if (legacy !== null && localStorage.getItem(scoped) === null) {
        localStorage.setItem(scoped, legacy)
      }
    } catch {
      // localStorage 不可用时，各读取函数会使用默认值。
    }
  }
}

export const copyFolderStorage = (sourceFolderId: string, targetFolderId: string) => {
  for (const key of FOLDER_SETTINGS_KEYS) {
    writeFolderValue(targetFolderId, key, readFolderValue(sourceFolderId, key))
  }
}

export const deleteFolderStorage = (folderId: string) => {
  for (const key of SCOPED_KEYS) {
    writeFolderValue(folderId, key, null)
  }
}
