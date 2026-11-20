import assert from 'node:assert/strict'

const values = new Map()
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => { values.set(key, String(value)) },
  removeItem: key => { values.delete(key) },
}

const {
  copyFolderStorage,
  deleteFolderStorage,
  getActiveFolderId,
  migrateLegacyFolderStorage,
  readActiveFolderId,
  readFolderValue,
  scopedStorageKey,
  setActiveFolderId,
  writeFolderValue,
} = await import('../../src/services/chat/folderStorage.ts')

values.set('chat-demo:api-key', 'legacy-key')
values.set('chat-demo:chat-memory', JSON.stringify({ enabled: true, pinned: 'legacy memory' }))
values.set('chat-demo:locale', 'zh-CN')
migrateLegacyFolderStorage()
assert.equal(readFolderValue('default', 'chat-demo:api-key'), 'legacy-key')
assert.equal(JSON.parse(readFolderValue('default', 'chat-demo:chat-memory')).pinned, 'legacy memory')
assert.equal(readFolderValue('default', 'chat-demo:locale'), null)

values.set('chat-demo:api-key', 'changed-legacy-key')
migrateLegacyFolderStorage()
assert.equal(readFolderValue('default', 'chat-demo:api-key'), 'legacy-key', 'migration must not overwrite folder edits')

copyFolderStorage('default', 'work')
assert.equal(readFolderValue('work', 'chat-demo:api-key'), 'legacy-key')
assert.equal(readFolderValue('work', 'chat-demo:chat-memory'), null)
assert.equal(JSON.parse(readFolderValue('default', 'chat-demo:chat-memory')).pinned, 'legacy memory')
writeFolderValue('work', 'chat-demo:api-key', 'work-key')
writeFolderValue('work', 'chat-demo:chat-memory', JSON.stringify({ pinned: 'work memory' }))
assert.equal(readFolderValue('default', 'chat-demo:api-key'), 'legacy-key')
assert.equal(readFolderValue('work', 'chat-demo:api-key'), 'work-key')

setActiveFolderId('work')
assert.equal(getActiveFolderId(), 'work')
assert.equal(readActiveFolderId(), 'work')
assert.equal(scopedStorageKey('a/b', 'chat-demo:compact').includes('a%2Fb'), true)
deleteFolderStorage('work')
assert.equal(readFolderValue('work', 'chat-demo:api-key'), null)
assert.equal(readFolderValue('work', 'chat-demo:chat-memory'), null)
assert.equal(readFolderValue('default', 'chat-demo:api-key'), 'legacy-key')
assert.equal(values.get('chat-demo:locale'), 'zh-CN')

const { favoriteId } = await import('../../src/services/chat/favoriteTypes.ts')
const { toSessionSummary } = await import('../../src/services/chat/types.ts')
assert.notEqual(favoriteId('default', 'same-session', 'same-message'), favoriteId('work', 'same-session', 'same-message'))
assert.deepEqual(toSessionSummary({
  id: 'session', folderId: 'work', title: 'title', createdAt: 1, updatedAt: 2,
}), { id: 'session', folderId: 'work', title: 'title', createdAt: 1, updatedAt: 2 })

console.log('PASS folder-scoped storage, summary and favorite identity')
