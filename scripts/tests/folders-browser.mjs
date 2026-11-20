import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { strFromU8, unzipSync } from 'fflate'

// Run after pnpm build. No model requests are made; all state lives in a temporary browser profile.
const bundledWeb = resolve(process.argv[2] || 'dist')
const scripts = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer((request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname
  const path = resolve(bundledWeb, '.' + (name === '/' ? '/index.html' : name))
  try {
    if (!path.startsWith(bundledWeb + sep)) throw Error('Invalid path')
    response.setHeader('Content-Type', scripts[extname(path)] || 'application/octet-stream')
    response.setHeader('Content-Security-Policy',
      "script-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; connect-src 'self' https://api.deepseek.com")
    response.end(readFileSync(path))
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port
const profile = mkdtempSync(join(tmpdir(), 'deepseek-folders-'))
const downloadDir = mkdtempSync(join(tmpdir(), 'deepseek-folders-downloads-'))
const browser = spawn(process.env.BROWSER_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore', windowsHide: true })
let socket

async function waitFor(action) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await action()
    if (result) return result
    await pause(150)
  }
  throw Error('Timed out waiting for ' + action)
}

function assertArchive(path, expected) {
  const entries = unzipSync(new Uint8Array(readFileSync(path)))
  const readJson = (name) => JSON.parse(strFromU8(entries[name]))
  assert.equal(readJson('manifest.json').export_format_version, 3)
  assert.deepEqual(Object.keys(entries).filter(name => /^chat_sessions\/[^/]+\.json$/.test(name)), [
    'chat_sessions/shared-session.json',
  ])
  const index = readJson('chat_session_index.json')
  assert.equal(index.length, 1)
  assert.equal(index[0].id, 'shared-session')
  assert.equal(index[0].title, expected.title)
  const sessionText = strFromU8(entries['chat_sessions/shared-session.json'])
  const session = JSON.parse(sessionText)
  assert.equal(session.id, 'shared-session')
  assert.equal(session.title, expected.title)
  for (const text of [expected.question, expected.answer]) assert(sessionText.includes(text))
  for (const text of expected.excluded) assert(!sessionText.includes(text), 'archive leaked: ' + text)
  const attachments = Object.keys(entries).filter(name => name.startsWith('chat_sessions/shared-session_files/'))
  assert.equal(attachments.length, 1)
  assert.equal(strFromU8(entries[attachments[0]]), expected.file)
}

// Serialized into Page.addScriptToEvaluateOnNewDocument. Keep this function self-contained.
function seedLegacyDatabase() {
  localStorage.setItem('chat-demo:api-key', 'legacy-key')
  localStorage.setItem('chat-demo:compact', JSON.stringify({ enabled: true, preset: '200000', custom: 200000 }))
  localStorage.setItem('chat-demo:chat-memory', JSON.stringify({
    enabled: true, autoDream: false, pinned: '旧记忆', sections: { personal: '旧分节' },
    sectionSources: { personal: ['shared-session:message'] },
    observations: [{ text: '旧观察', confidence: 'observed', source: 'shared-session:message' }],
    entities: [{ name: '旧实体', aliases: [], text: '旧实体说明', source: 'shared-session:message' }],
    lastDream: 100, checkpoints: { 'shared-session': { messageId: 'message', digest: '旧摘要' } },
    skippedSessions: ['shared-session'], nextDreamSessionIds: ['shared-session'],
    dreamNeedsSelection: true, log: [{ at: 100, sessions: 1 }],
  }))
  localStorage.setItem('chat-demo:locale', 'zh-CN')
  const seed = indexedDB.open('chat-demo', 13)
  seed.onupgradeneeded = () => {
    const db = seed.result
    for (const name of [
      'sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging',
      'favorites', 'favoriteSnapshots', 'requestJournals', 'requestPayloads',
    ]) db.createObjectStore(name, { keyPath: 'id' })
    seed.transaction.objectStore('sessionSummaries').createIndex('fileIds', 'fileIds', { multiEntry: true })
    seed.transaction.objectStore('requestJournals').createIndex('sessionId', 'sessionId')
    seed.transaction.objectStore('requestPayloads').createIndex('sessionId', 'sessionId')
    seed.transaction.objectStore('requestPayloads').createIndex('journalId', 'journalId')

    const at = Date.now() - 100000
    const makeSession = (id, title, answer, fileId) => ({
      id, title, createdAt: at, updatedAt: at,
      messages: [
        {
          id: 'legacy-user', role: 'user', createdAt: at, content: '默认问题',
          files: fileId ? [{
            id: fileId, serverId: null, name: '共享原件.txt', size: 20,
            isImage: true, mimeType: 'image/png',
          }] : [],
        },
        {
          id: 'legacy-reply', role: 'assistant', createdAt: at + 1,
          provider: 'deepseek', model: 'deepseek-flash', status: 'done', prefix: true,
          thinking: false, search: false, blocks: [{ type: 'text', text: answer }],
          requestCapture: { runId: 'legacy-run', state: 'complete' },
        },
      ],
    })
    const session = makeSession('shared-session', '默认共享 ID 对话', '默认正文', 'shared-file')
    const staging = makeSession('legacy-staging', '旧暂存对话', '旧暂存正文', 'staging-file')
    const journalId = JSON.stringify([session.id, 'legacy-reply'])
    const captured = {
      id: 'legacy-request', at: at + 2, url: 'https://api.deepseek.com/anthropic/v1/messages',
      method: 'POST', headers: { 'content-type': 'application/json' }, httpStatus: 200,
      outcome: 'response', payloadAvailable: true,
    }
    const favorite = {
      id: 'legacy-favorite', sessionId: session.id, messageId: 'legacy-reply',
      sessionTitle: session.title, savedAt: at + 3, provider: 'deepseek', model: 'deepseek-flash',
      preview: '默认正文', contextCount: 1, requestCaptureState: 'complete', requestCount: 1,
    }
    const snapshot = {
      version: 2, id: 'legacy-favorite', savedAt: at + 3, messageId: 'legacy-reply',
      likedText: '默认正文', session,
      files: [{ id: 'shared-file', blob: new Blob(['favorite-file-content'], { type: 'text/plain' }) }],
      missingFileIds: [], requestCapture: { state: 'complete', requests: [captured] },
    }
    const values = {
      sessions: [session],
      sessionSummaries: [{
        id: session.id, title: session.title, createdAt: at, updatedAt: at, fileIds: ['shared-file'],
      }],
      files: [{ id: 'shared-file', blob: new Blob(['default-file-content'], { type: 'text/plain' }) }],
      sessionsStaging: [staging],
      filesStaging: [{ id: 'staging-file', blob: new Blob(['staging-file-content'], { type: 'text/plain' }) }],
      favorites: [favorite],
      favoriteSnapshots: [snapshot],
      requestJournals: [{
        version: 1, runId: 'legacy-run', id: journalId, sessionId: session.id,
        messageId: 'legacy-reply', state: 'complete', createdAt: at + 1, updatedAt: at + 3,
        replyStatus: 'done', requests: [captured],
      }],
      requestPayloads: [{
        id: captured.id, journalId, sessionId: session.id, encoding: 'json',
        body: new Blob(['{"legacy":true}'], { type: 'application/json' }), characters: 15,
      }],
    }
    for (const [name, records] of Object.entries(values)) {
      for (const record of records) seed.transaction.objectStore(name).put(record)
    }
  }
  seed.onsuccess = () => seed.result.close()
  seed.onerror = () => {} // Reloading an upgraded database must not downgrade it.
}

try {
  const port = await waitFor(() => {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] }
    catch { return false }
  })
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  const pending = new Map()
  const diagnostics = []
  let id = 0
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data)
    if (event.id) {
      const callback = pending.get(event.id)
      pending.delete(event.id)
      if (event.error) callback.reject(event.error)
      else callback.resolve(event.result)
    }
    if (event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded') {
      diagnostics.push(event.params)
    }
  })
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const pageText = () => evaluate('document.body?.innerText || ""')
  const hasText = (text) => waitFor(async () => (await pageText()).includes(text))
  const click = (text) => evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x =>
      x.getClientRects().length && !x.disabled &&
      (x.innerText.trim() === ${JSON.stringify(text)} || x.getAttribute('aria-label') === ${JSON.stringify(text)}));
    if (!b) throw Error('Button missing: ' + ${JSON.stringify(text)}); b.click()
  })()`)
  const dialogButton = (text) => evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role=dialog]')];
    const b = [...dialogs.at(-1).querySelectorAll('button')].find(x =>
      !x.disabled && x.innerText.trim() === ${JSON.stringify(text)});
    if (!b) throw Error('Dialog button missing: ' + ${JSON.stringify(text)}); b.click()
  })()`)
  const setDialogInput = (value) => evaluate(`(() => {
    const input = [...document.querySelectorAll('[role=dialog]')].at(-1).querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const activeFolder = () => evaluate('document.querySelector("button[aria-label=对话文件夹]")?.innerText.trim()')
  const selectFolder = async (name) => {
    await evaluate('document.querySelector("button[aria-label=对话文件夹]").click()')
    await waitFor(() => evaluate('!!document.querySelector("[role=listbox][aria-label=对话文件夹]")'))
    await evaluate(`(() => {
      const option = [...document.querySelectorAll('[role=listbox][aria-label=对话文件夹] [role=option]')]
        .find(el => el.innerText.trim() === ${JSON.stringify(name)});
      if (!option) throw Error('Folder missing: ' + ${JSON.stringify(name)}); option.click()
    })()`)
    await waitFor(async () => await activeFolder() === name)
    await waitFor(() => evaluate('!document.querySelector("button[aria-label=对话文件夹]").disabled'))
  }
  const selectTitle = (title) => evaluate(`(() => {
    const titleNode = [...document.querySelectorAll('div')].find(el =>
      el.childElementCount === 0 && el.textContent.trim() === ${JSON.stringify(title)} &&
      el.parentElement?.querySelector('button[aria-label=更多]'));
    if (!titleNode) throw Error('Session missing: ' + ${JSON.stringify(title)});
    titleNode.parentElement.click()
  })()`)
  const openFavorites = () => evaluate(`Array.from(document.querySelectorAll('button'))
    .find(el => el.getClientRects().length && el.innerText.trim().startsWith('收藏')).click()`)
  const readStore = (store) => evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('chat-demo'); req.onerror = () => reject(req.error);
    req.onsuccess = () => { const db = req.result;
      const get = db.transaction(${JSON.stringify(store)}).objectStore(${JSON.stringify(store)}).getAll();
      get.onsuccess = () => { resolve(get.result); db.close() }; get.onerror = () => reject(get.error);
    }
  })`)
  const readRecord = (store, key) => evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('chat-demo'); req.onerror = () => reject(req.error);
    req.onsuccess = () => { const db = req.result;
      const get = db.transaction(${JSON.stringify(store)}).objectStore(${JSON.stringify(store)}).get(${JSON.stringify(key)});
      get.onsuccess = () => { resolve(get.result); db.close() }; get.onerror = () => reject(get.error);
    }
  })`)
  const readFile = (folderId, fileId) => evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('chat-demo'); req.onerror = () => reject(req.error);
    req.onsuccess = () => { const db = req.result;
      const get = db.transaction('files').objectStore('files').get([${JSON.stringify(folderId)}, ${JSON.stringify(fileId)}]);
      get.onsuccess = async () => { resolve(await get.result.blob.text()); db.close() }; get.onerror = () => reject(get.error);
    }
  })`)
  const localValue = (key) => evaluate(`localStorage.getItem(${JSON.stringify(key)})`)
  const scopedKey = (folderId, key) => `chat-demo:folder:${encodeURIComponent(folderId)}:${key}`
  const exportCurrentFolder = async (name) => {
    const before = new Set(readdirSync(downloadDir))
    await click('设置')
    await click('数据管理')
    await click('下载')
    const path = await waitFor(() => {
      const names = readdirSync(downloadDir)
      const created = names.filter(name => name.endsWith('.zip') && !before.has(name))
      return created.length === 1 && !names.some(name => name.endsWith('.crdownload'))
        ? join(downloadDir, created[0]) : false
    })
    await click('关闭')
    // Export filenames only contain the date; preserve the first ZIP before downloading the second.
    const preservedPath = join(downloadDir, name + '.zip')
    renameSync(path, preservedPath)
    return preservedPath
  }
  const importIntoCurrentFolder = async (path) => {
    await click('设置')
    await click('数据管理')
    const { root } = await send('DOM.getDocument', { depth: 1 })
    const { nodeId } = await send('DOM.querySelector', {
      nodeId: root.nodeId, selector: '[role=dialog] input[type=file]',
    })
    assert(nodeId, 'history ZIP input should exist')
    await send('DOM.setFileInputFiles', { nodeId, files: [path] })
    await hasText('确认导入到当前文件夹？')
    await dialogButton('确认导入')
    await hasText('已导入 1 个对话')
    await click('关闭')
  }
  const readProtectedState = async () => {
    const state = await evaluate(`(async () => {
      const names = ['sessions', 'files', 'requestJournals', 'requestPayloads', 'favorites', 'favoriteSnapshots'];
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open('chat-demo'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
      });
      const tx = db.transaction(names, 'readonly');
      const values = await Promise.all(names.map(name => new Promise((resolve, reject) => {
        const get = tx.objectStore(name).getAll(); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
      })));
      db.close();
      const result = Object.fromEntries(names.map((name, index) => [name, values[index]]));
      for (const name of ['sessions', 'files', 'requestJournals', 'requestPayloads']) {
        result[name] = result[name].filter(item => item.folderId === 'default');
      }
      const normalize = async value => {
        if (value instanceof Blob) return {
          __blob: true, type: value.type, bytes: Array.from(new Uint8Array(await value.arrayBuffer())),
        };
        if (Array.isArray(value)) return Promise.all(value.map(normalize));
        if (value && typeof value === 'object') {
          const output = {};
          for (const [key, item] of Object.entries(value)) output[key] = await normalize(item);
          return output;
        }
        return value;
      };
      return normalize(result);
    })()`)
    return state
  }

  await send('Page.enable')
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
  await send('DOM.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1360, height: 840, deviceScaleFactor: 1, mobile: false,
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${seedLegacyDatabase})()` })
  await send('Page.navigate', { url: origin })
  try {
    await hasText('默认共享 ID 对话')
    assert.equal(await activeFolder(), '默认文件夹')
    assert.equal(await evaluate('indexedDB.databases().then(items => items.find(db => db.name === "chat-demo").version)'), 14)

    // v13 records have no folder fields; migration must preserve every store under default.
    for (const store of [
      'sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging',
      'requestJournals', 'requestPayloads',
    ]) {
      const records = await readStore(store)
      assert.equal(records.length, 1, store + ' record count')
      assert.equal(records[0].folderId, 'default', store + ' folderId')
    }
    const migratedFavorites = await readStore('favorites')
    const migratedSnapshots = await readStore('favoriteSnapshots')
    const defaultFavoriteId = JSON.stringify(['default', 'shared-session', 'legacy-reply'])
    assert.equal(migratedFavorites.length, 1)
    assert.equal(migratedFavorites[0].id, defaultFavoriteId)
    assert.equal(migratedFavorites[0].sourceFolderId, 'default')
    assert.equal(migratedSnapshots[0].id, defaultFavoriteId)
    assert.equal(migratedSnapshots[0].session.folderId, 'default')
    assert.equal(await localValue(scopedKey('default', 'chat-demo:api-key')), 'legacy-key')
    assert.equal(JSON.parse(await localValue(scopedKey('default', 'chat-demo:compact'))).enabled, true)
    assert.equal(JSON.parse(await localValue(scopedKey('default', 'chat-demo:chat-memory'))).pinned, '旧记忆')
    assert.equal(await localValue('chat-demo:locale'), 'zh-CN')

    await openFavorites()
    await hasText('默认正文')
    assert((await pageText()).includes('默认文件夹'))
    await click('关闭')

    // Renaming the source folder is reflected by global favorites.
    await click('管理')
    await setDialogInput('主文件夹')
    await dialogButton('确定')
    await waitFor(async () => await activeFolder() === '主文件夹')
    await openFavorites()
    await hasText('主文件夹')
    await click('关闭')

    // Creation inherits settings and switches to an empty history and memory vault.
    await click('新建')
    await setDialogInput('work')
    await dialogButton('确定')
    await waitFor(async () => await activeFolder() === 'work')
    const workFolder = (await readStore('folders')).find(folder => folder.name === 'work')
    assert(workFolder, 'work folder should be persisted')
    const workId = workFolder.id
    for (const key of ['chat-demo:api-key', 'chat-demo:compact']) {
      assert.equal(await localValue(scopedKey(workId, key)), await localValue(scopedKey('default', key)), key + ' clone')
    }
    const newMemory = JSON.parse(await localValue(scopedKey(workId, 'chat-demo:chat-memory')))
    assert.equal(newMemory.enabled, true)
    assert.equal(newMemory.autoDream, false)
    assert.equal(newMemory.pinned, '')
    assert(Object.values(newMemory.sections).every(text => text === ''))
    assert.deepEqual(newMemory.sectionSources, {})
    assert.deepEqual(newMemory.observations, [])
    assert.deepEqual(newMemory.entities, [])
    assert.deepEqual(newMemory.checkpoints, {})
    assert.deepEqual(newMemory.skippedSessions, [])
    assert.equal(newMemory.nextDreamSessionIds, null)
    assert.equal(newMemory.lastDream, 0)
    assert.equal(newMemory.dreamNeedsSelection, false)
    assert.deepEqual(newMemory.log, [])
    assert(!(await pageText()).includes('默认共享 ID 对话'))

    const workCompact = JSON.stringify({ enabled: false, preset: 'custom', custom: 123456 })
    const workMemory = JSON.stringify({ enabled: true, pinned: '工作记忆' })
    await evaluate(`(() => {
      localStorage.setItem(${JSON.stringify(scopedKey(workId, 'chat-demo:api-key'))}, 'work-key');
      localStorage.setItem(${JSON.stringify(scopedKey(workId, 'chat-demo:compact'))}, ${JSON.stringify(workCompact)});
      localStorage.setItem(${JSON.stringify(scopedKey(workId, 'chat-demo:chat-memory'))}, ${JSON.stringify(workMemory)});
    })()`)
    await send('Page.reload')
    await waitFor(async () => await activeFolder() === 'work')
    assert.equal(await localValue(scopedKey(workId, 'chat-demo:api-key')), 'work-key')
    assert.equal(JSON.parse(await localValue(scopedKey(workId, 'chat-demo:compact'))).custom, 123456)
    assert.equal(JSON.parse(await localValue(scopedKey(workId, 'chat-demo:chat-memory'))).pinned, '工作记忆')
    await selectFolder('主文件夹')
    await hasText('默认共享 ID 对话')
    assert.equal(await localValue(scopedKey('default', 'chat-demo:api-key')), 'legacy-key')
    assert.equal(JSON.parse(await localValue(scopedKey('default', 'chat-demo:compact'))).enabled, true)
    assert.equal(JSON.parse(await localValue(scopedKey('default', 'chat-demo:chat-memory'))).pinned, '旧记忆')
    assert.equal(JSON.parse(await localValue(scopedKey('default', 'chat-demo:chat-memory'))).checkpoints['shared-session'].digest, '旧摘要')
    await selectFolder('work')
    assert(!(await pageText()).includes('默认共享 ID 对话'))

    // Deliberately reuse session/message/file IDs with different work content.
    await evaluate(`(async () => {
      const folderId = ${JSON.stringify(workId)};
      const at = Date.now();
      const session = {
        id: 'shared-session', folderId, title: '工作共享 ID 对话', createdAt: at, updatedAt: at,
        messages: [
          { id: 'legacy-user', role: 'user', createdAt: at, content: '工作问题', files: [{
            id: 'shared-file', serverId: null, name: '工作原件.txt', size: 17,
            isImage: true, mimeType: 'image/png',
          }] },
          { id: 'legacy-reply', role: 'assistant', createdAt: at + 1,
            provider: 'deepseek', model: 'deepseek-flash', status: 'done', prefix: true,
            thinking: false, search: false, blocks: [{ type: 'text', text: '工作正文' }] },
        ],
      };
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open('chat-demo'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite');
        tx.objectStore('sessions').put(session);
        tx.objectStore('sessionSummaries').put({
          id: session.id, folderId, title: session.title, createdAt: at, updatedAt: at, fileIds: ['shared-file'],
        });
        tx.objectStore('files').put({ id: 'shared-file', folderId, blob: new Blob(['work-file-content'], { type: 'text/plain' }) });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      db.close();
    })()`)
    await send('Page.reload')
    await hasText('工作共享 ID 对话')
    assert(!(await pageText()).includes('默认共享 ID 对话'))
    await selectTitle('工作共享 ID 对话')
    await hasText('工作正文')
    assert(!(await pageText()).includes('默认正文'))
    assert.equal((await readRecord('sessions', [workId, 'shared-session'])).messages[1].blocks[0].text, '工作正文')
    assert.equal(await readFile(workId, 'shared-file'), 'work-file-content')

    // Same session/message IDs in two folders still produce distinct global favorites.
    await evaluate(`Array.from(document.querySelectorAll('[data-chat-message-id]'))
      .find(el => el.innerText.includes('工作正文')).querySelector('button[aria-label=收藏回复]').click()`)
    await hasText('收藏 · 2')
    const workFavoriteId = JSON.stringify([workId, 'shared-session', 'legacy-reply'])
    assert.notEqual(workFavoriteId, defaultFavoriteId)
    assert.equal((await readStore('favorites')).find(item => item.sourceFolderId === workId).id, workFavoriteId)
    await openFavorites()
    await hasText('工作正文')
    await hasText('默认正文')
    assert((await pageText()).includes('work'))
    assert((await pageText()).includes('主文件夹'))
    await click('关闭')
    const workArchive = await exportCurrentFolder('work-export')

    await selectFolder('主文件夹')
    await hasText('默认共享 ID 对话')
    assert(!(await pageText()).includes('工作共享 ID 对话'))
    await selectTitle('默认共享 ID 对话')
    await hasText('默认正文')
    assert(!(await pageText()).includes('工作正文'))
    assert.equal((await readRecord('sessions', ['default', 'shared-session'])).messages[1].blocks[0].text, '默认正文')
    assert.equal(await readFile('default', 'shared-file'), 'default-file-content')
    await openFavorites()
    await hasText('工作正文')
    await hasText('默认正文')
    await click('关闭')
    const defaultArchive = await exportCurrentFolder('default-export')

    // Both folders deliberately export the same session/file IDs but different content and originals.
    assertArchive(defaultArchive, {
      title: '默认共享 ID 对话', question: '默认问题', answer: '默认正文', file: 'default-file-content',
      excluded: ['工作共享 ID 对话', '工作问题', '工作正文', 'work-file-content'],
    })
    assertArchive(workArchive, {
      title: '工作共享 ID 对话', question: '工作问题', answer: '工作正文', file: 'work-file-content',
      excluded: ['默认共享 ID 对话', '默认问题', '默认正文', 'default-file-content'],
    })

    // Importing default's real ZIP replaces only work; protected records compare byte-for-byte.
    await selectFolder('work')
    const protectedBeforeImport = await readProtectedState()
    await importIntoCurrentFolder(defaultArchive)
    assert.deepEqual(await readProtectedState(), protectedBeforeImport)
    const importedWorkSessions = (await readStore('sessions')).filter(item => item.folderId === workId)
    assert.equal(importedWorkSessions.length, 1)
    assert.equal(importedWorkSessions[0].id, 'shared-session')
    assert.equal(importedWorkSessions[0].title, '默认共享 ID 对话')
    assert.equal(importedWorkSessions[0].messages[0].content, '默认问题')
    assert.equal(importedWorkSessions[0].messages[0].files[0].id, 'shared-file')
    assert.equal(importedWorkSessions[0].messages[1].blocks[0].text, '默认正文')
    assert(!JSON.stringify(importedWorkSessions).includes('工作正文'))
    assert.equal((await readRecord('sessions', ['default', 'shared-session'])).messages[1].blocks[0].text, '默认正文')
    assert.equal((await readStore('sessionSummaries')).filter(item => item.folderId === workId).length, 1)
    assert.equal((await readStore('sessionsStaging')).filter(item => item.folderId === workId).length, 0)
    assert.equal((await readStore('filesStaging')).filter(item => item.folderId === workId).length, 0)
    assert.equal((await readStore('requestJournals')).filter(item => item.folderId === workId).length, 0)
    assert.equal((await readStore('requestPayloads')).filter(item => item.folderId === workId).length, 0)
    const importedWorkFiles = (await readStore('files')).filter(item => item.folderId === workId)
    assert.equal(importedWorkFiles.length, 1)
    assert.equal(importedWorkFiles[0].id, 'shared-file')
    assert.equal(await readFile(workId, 'shared-file'), 'default-file-content')
    assert.equal(await readFile('default', 'shared-file'), 'default-file-content')
    await selectTitle('默认共享 ID 对话')
    await hasText('默认正文')
    assert(!(await pageText()).includes('工作共享 ID 对话'))

    // Data-management deletion is scoped to work and never deletes global evidence.
    await click('设置')
    await click('数据管理')
    await hasText('删除当前文件夹的所有对话')
    await dialogButton('删除')
    await hasText('删除后，当前文件夹的所有对话都将被清空且无法找回')
    await dialogButton('删除当前文件夹的所有对话')
    await waitFor(async () => (await readStore('sessions')).filter(item => item.folderId === workId).length === 0)
    assert.equal((await readStore('sessions')).filter(item => item.folderId === 'default').length, 1)
    assert.equal((await readStore('favorites')).length, 2)
    assert.equal((await readStore('favoriteSnapshots')).length, 2)
    await click('关闭')

    // Folder deletion removes work data/settings but retains both favorite snapshots.
    await click('管理')
    await dialogButton('删除文件夹')
    await hasText('删除此文件夹？')
    await dialogButton('删除')
    await waitFor(async () => await activeFolder() === '主文件夹')
    await hasText('默认共享 ID 对话')
    assert.equal((await readStore('folders')).some(folder => folder.id === workId), false)
    assert.equal((await readStore('sessions')).filter(item => item.folderId === workId).length, 0)
    assert.equal((await readStore('files')).filter(item => item.folderId === workId).length, 0)
    assert.equal(await localValue(scopedKey(workId, 'chat-demo:api-key')), null)
    assert.equal(await localValue(scopedKey('default', 'chat-demo:api-key')), 'legacy-key')
    const retainedFavorites = await readStore('favorites')
    const retainedSnapshots = await readStore('favoriteSnapshots')
    assert.equal(retainedFavorites.length, 2)
    assert.equal(retainedSnapshots.length, 2)
    assert(retainedFavorites.some(item => item.id === workFavoriteId && item.sourceFolderId === workId))
    const retainedWorkSnapshot = retainedSnapshots.find(item => item.id === workFavoriteId)
    assert.equal(retainedWorkSnapshot.session.folderId, workId)
    const retainedWorkFile = await evaluate(`new Promise(resolve => {
      const open = indexedDB.open('chat-demo'); open.onsuccess = () => {
        const db = open.result; const get = db.transaction('favoriteSnapshots').objectStore('favoriteSnapshots').get(${JSON.stringify(workFavoriteId)});
        get.onsuccess = async () => { resolve(await get.result.files[0].blob.text()); db.close() };
      };
    })`)
    assert.equal(retainedWorkFile, 'work-file-content')

    console.log('PASS v13-to-v14 migration; scoped settings/history; composite session/file keys; real ZIP export/import isolation; unchanged default/favorites; global favorite snapshots survive deletion')
  } catch (error) {
    console.error(await pageText(), JSON.stringify(diagnostics).slice(0, 2000))
    throw error
  }
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
