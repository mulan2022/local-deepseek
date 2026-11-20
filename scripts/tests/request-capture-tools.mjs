import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

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
const profile = mkdtempSync(join(tmpdir(), 'deepseek-smoke-'))
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

try {
  const port = await waitFor(() => {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] }
    catch { return false }
  })
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  const pending = new Map()
  const requests = []
  const rawRequests = []
  const localRequests = []
  const diagnostics = []
  let id = 0
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const sse = (title, answer) => [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.slice(0, 2) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.slice(2) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', title }, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } },
    { type: 'message_stop' },
  ].map((data) => 'event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n').join('')

  const events = (frames) => frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('')
  const transform = (body) => {
    requests.push(body)
    const user = body.messages.at(-1)
    const extended = body.safety_check?.level === 'high' && body.tools.some(tool => tool.name === 'deepseek_web_search')
    if (!extended) return sse('', '请求丢失联网或安全配置')
    if (user.content[0]?.type === 'tool_result') {
      if (user.content.some(block => block.type === 'tool_result' && typeof block.content !== 'string')) {
        return { rejection: JSON.stringify({ error: { message: "messages.76: only text content is supported in tool_result blocks with deepseek_web_search, deepseek_read_url, safety_check or title yet" } }) }
      }
      return sse('截图回归', '收到了游戏画面')
    }
    return events([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '先拿到截图', signature: 'mock-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'shot-1', name: 'phone_capture', input: {} } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'plan-1', name: 'phone_heartbeat', input: { mode: 'interval', value: '1' } } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
  }
  socket.addEventListener('message', async ({ data }) => {
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
    if (event.method !== 'Fetch.requestPaused') return
    const { request, requestId } = event.params
    const initial = request.method === 'OPTIONS'
    let content
    if (!initial) {
      const body = JSON.parse(request.postData)
      rawRequests.push(request.postData)
      content = transform(body)
    }
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: initial ? 204 : content.rejection ? 400 : 200,
      responseHeaders: Object.entries({
        'content-type': 'text/event-stream',
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'content-type,x-api-key,anthropic-version,anthropic-beta',
        'access-control-allow-methods': 'POST,OPTIONS',
      }).map(([name, value]) => ({ name, value })),
      body: initial ? undefined : Buffer.from(content.rejection ?? content).toString('base64'),
    })
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
  const waitForButton = (text) => waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(
    b => b.getClientRects().length && !b.disabled && b.innerText.trim() === ${JSON.stringify(text)})`))
  const type = async (text) => {
    await waitFor(() => evaluate('!!document.querySelector("textarea")'))
    await evaluate(`(() => {
      const t = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(text)});
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1360, height: 840, deviceScaleFactor: 1, mobile: false,
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.deepseek.com/anthropic/v1/messages' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "\nconst fake = {\n  mode: 'off', value: '', sessionId: '', task: '', at: 0, calls: [], done: [], pending: null, shots: [],\n}\nwindow.fake = fake\nwindow.AndroidPhoneTools = {\n  state: () => JSON.stringify({ heartbeat: true, capture: true, captureActive: true, ...fake }),\n  configureHeartbeat(mode, value, task, sessionId) {\n    Object.assign(fake, { mode, value, task, sessionId, at: Date.now() })\n    fake.calls.push({ mode, value, sessionId })\n    return ''\n  },\n  captureFrame() { fake.shots.push(Date.now()); return 'bW9jay1zY3JlZW4=' },\n}\nwindow.AndroidHeartbeat = {\n  pending: () => JSON.stringify(fake.pending),\n  isHeadless: () => false,\n  complete(id, status, text) {\n    fake.done.push({ id, status, text })\n    fake.pending = null\n    window.dispatchEvent(new Event('android-heartbeat'))\n  },\n}\nlocalStorage.setItem('chat-demo:api-key','mock-key')\nlocalStorage.setItem('chat-demo:locale','zh-CN')\n\n  localStorage.setItem('chat-demo:thinking','true')\n  localStorage.setItem('chat-demo:search','true')\n\nlocalStorage.setItem('chat-demo:chat-memory',JSON.stringify({enabled:true,pinned:'请求留档记忆 M-1249'}))\n" })
  await send('Page.navigate', { url: origin })
  try {

    await hasText('Singula')
    await type('看看游戏画面')
    await click('发送')
    await hasText('收到了游戏画面')
    assert.equal(requests.length, 2)
    const [first, second] = requests
    assert.deepEqual(second.messages.slice(0,first.messages.length), first.messages)
    assert.deepEqual(second.thinking, { type: 'enabled' })
    assert.deepEqual(second.tools, first.tools)
    assert.deepEqual(second.safety_check, first.safety_check)
    assert.deepEqual(second.title, first.title)
    assert.equal(second.messages.at(-2).content[0].signature, 'mock-signature')
    const blocks = second.messages.at(-1).content
    assert.deepEqual(blocks.map(block => block.type), ['tool_result', 'tool_result', 'image'])
    assert.equal(blocks[0].tool_use_id, 'shot-1')
    assert(blocks[0].content.includes('工具截图 1'))
    assert.equal(blocks[1].tool_use_id, 'plan-1')
    assert(JSON.parse(blocks[1].content).ok)
    assert.equal(blocks[2].source.data, 'bW9jay1zY3JlZW4=')
    assert.equal(await evaluate('window.fake.shots.length'), 1)
    assert.equal(await evaluate('window.fake.calls.length'), 1)
    console.log('PASS text-only tool results and sibling image, multi-tool order, thinking signature, KV message prefix, web tools and safety')

    await waitFor(()=>evaluate('document.querySelector("button[aria-label=收藏回复]")?.disabled===false'))
    await click('收藏回复')
    await hasText('收藏 · 1')
    const captured=await evaluate('new Promise(resolve=>{const r=indexedDB.open("chat-demo");r.onsuccess=()=>{const db=r.result;const g=db.transaction("favoriteSnapshots").objectStore("favoriteSnapshots").getAll();g.onsuccess=async()=>{const s=g.result[0];const entries=await Promise.all(s.requestCapture.requests.map(async item=>({...item,payload:undefined,body:item.payload.encoding==="gzip"?await new Response(item.payload.body.stream().pipeThrough(new DecompressionStream("gzip"))).text():await item.payload.body.text()})));resolve({state:s.requestCapture.state,entries});db.close()}}})')
    assert.equal(captured.state,'complete')
    assert.equal(captured.entries.length,2)
    assert.deepEqual(captured.entries.map(entry=>entry.body),rawRequests)
    assert(captured.entries[0].body.includes('请求留档记忆 M-1249'))
    assert(captured.entries[0].body.includes('mem_search'))
    assert(captured.entries[0].body.includes('phone_heartbeat'))
    const secondBody=JSON.parse(captured.entries[1].body)
    assert.equal(secondBody.messages.at(-1).content.at(-1).source.data,'bW9jay1zY3JlZW4=')
    assert.equal(secondBody.messages.at(-2).content[0].signature,'mock-signature')
    assert(secondBody.messages.at(-1).content.some(block=>block.type==='tool_result'))
    assert(!JSON.stringify(captured.entries.map(entry=>entry.headers)).includes('mock-key'))
    await evaluate('window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==="requestPayloads")throw new DOMException("mock quota","QuotaExceededError");return window.originalPut.apply(this,args)}')
    await type('再次看看画面')
    await click('发送')
    await waitFor(()=>requests.length===4)
    await waitFor(()=>evaluate('document.querySelector("button[aria-label=收藏回复]")?.disabled===false'))
    await evaluate('IDBObjectStore.prototype.put=window.originalPut')
    await click('收藏回复')
    await hasText('收藏 · 2')
    const incomplete=await evaluate('new Promise(resolve=>{const r=indexedDB.open("chat-demo");r.onsuccess=()=>{const db=r.result;const g=db.transaction("favoriteSnapshots").objectStore("favoriteSnapshots").getAll();g.onsuccess=()=>{resolve(g.result.find(s=>s.requestCapture.state==="partial")?.requestCapture);db.close()}}})')
    assert.equal(incomplete.state,'partial')
    assert.equal(incomplete.requests.length,2)
    assert(incomplete.requests.every(entry=>!entry.payload))
    console.log('PASS exact final wire JSON, frozen memory, tool schemas and results, screenshot bytes and thinking signatures; capture failure leaves chat usable and marks incomplete')
  } catch (error) {
    console.error(await pageText(), JSON.stringify(diagnostics).slice(0, 1600))
    throw error
  }
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
