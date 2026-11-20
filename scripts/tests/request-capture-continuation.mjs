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

 const transform=body=>{
   requests.push(body)
   const number=requests.length
   const output=sse('续写留档','片段'+number)
   return number%2===1 ? output.replaceAll('"stop_reason":"end_turn"','"stop_reason":"max_tokens"') : output
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
      content = transform(body)
    }
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: initial ? 204 : 200,
      responseHeaders: Object.entries({
        'content-type': 'text/event-stream',
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'content-type,x-api-key,anthropic-version,anthropic-beta',
        'access-control-allow-methods': 'POST,OPTIONS',
      }).map(([name, value]) => ({ name, value })),
      body: initial ? undefined : Buffer.from(content).toString('base64'),
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "\nlocalStorage.setItem('chat-demo:api-key','mock-key')\nlocalStorage.setItem('chat-demo:locale','zh-CN')\n" })
  await send('Page.navigate', { url: origin })
  try {

const readStore=store=>evaluate('new Promise(resolve=>{const r=indexedDB.open("chat-demo");r.onsuccess=()=>{const db=r.result;const g=db.transaction('+JSON.stringify(store)+').objectStore('+JSON.stringify(store)+').getAll();g.onsuccess=()=>{resolve(g.result);db.close()}}})')
const ready=label=>waitFor(()=>evaluate('document.querySelector("button[aria-label='+label+']")?.disabled===false'))
await hasText('Singula')
await type('成功续写留档测试')
await click('发送')
await hasText('片段1')
await ready('收藏回复')
await click('收藏回复')
await hasText('收藏 · 1')
let saved=await readStore('favoriteSnapshots')
assert.equal(saved[0].requestCapture.state,'complete')
assert.equal(saved[0].requestCapture.requests.length,1)
await click('继续生成')
await hasText('片段2')
await ready('取消收藏')
saved=await readStore('favoriteSnapshots')
assert.equal(saved[0].requestCapture.requests.length,1)
assert(!saved[0].likedText.includes('片段2'))
await click('取消收藏')
await ready('收藏回复')
await click('收藏回复')
await hasText('收藏 · 1')
saved=await readStore('favoriteSnapshots')
assert.equal(saved[0].requestCapture.requests.length,2)
assert.equal(saved[0].requestCapture.state,'complete')
await click('开启新对话')
await type('续写记录写入失败测试')
await click('发送')
await hasText('片段3')
await ready('收藏回复')
await click('收藏回复')
await hasText('收藏 · 2')
await evaluate('window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==="requestJournals")throw new DOMException("mock full journal storage","QuotaExceededError");return window.originalPut.apply(this,args)}')
await click('继续生成')
await hasText('片段4')
await ready('取消收藏')
await evaluate('IDBObjectStore.prototype.put=window.originalPut')
saved=await readStore('favoriteSnapshots')
const old=saved.find(s=>s.likedText.includes('片段3'))
assert.equal(old.requestCapture.state,'complete')
assert.equal(old.requestCapture.requests.length,1)
assert(!old.likedText.includes('片段4'))
await click('取消收藏')
await ready('收藏回复')
await click('收藏回复')
await hasText('收藏 · 2')
saved=await readStore('favoriteSnapshots')
const current=saved.find(s=>s.likedText.includes('片段4'))
assert.equal(current.requestCapture.state,'partial')
assert.equal(current.requestCapture.requests.length,0)
assert(!requests.some(request=>JSON.stringify(request).includes('"requestCapture"')))
console.log('PASS continuation appends captures, existing favorite remains immutable, stale successful journal cannot masquerade as a failed new run, local recording never leaks into model context')
  } catch (error) {
    console.error(await pageText(), JSON.stringify(diagnostics).slice(0, 1600))
    throw error
  }
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
