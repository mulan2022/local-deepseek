import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const bundledWeb = resolve(process.argv[2])
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
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
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
  const transform = (body) => { requests.push(body); return sse('悬浮测试', requests.length === 1 ? '第一条回复' : '小窗回复') }
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "\n  localStorage.setItem('chat-demo:api-key','mock-key')\n  localStorage.setItem('chat-demo:locale','zh-CN')\n  let active = false\n  window.overlayFocus = []\n  window.AndroidFloatingChat = {\n    active: () => active, open: () => window.setOverlay(true),\n    focusInput: (focused) => window.overlayFocus.push(focused),\n  }\n  window.setOverlay = (open) => {\n    active = open\n    window.dispatchEvent(new CustomEvent('android-floating-chat', { detail: open ? 'open' : 'closed' }))\n  }\n\nwindow.previewReplies=[];window.AndroidFloatingChat.notifyReply=(session,run,text,currentChat)=>window.previewReplies.push({session,run,text,currentChat});" })
  await send('Page.navigate', { url: origin })
  try {

    await hasText('Singula')
    await type('全屏第一条')
    await click('发送')
    await hasText('第一条回复')
    await type('小窗第二条')
    await click('悬浮球')
    await send('Emulation.setDeviceMetricsOverride', { width: 260, height: 200, deviceScaleFactor: 1, mobile: true })
    await waitFor(async () => !(await pageText()).includes('全屏第一条'))
    await hasText('第一条回复')
    assert.equal(await evaluate('document.querySelector("textarea").value'), '小窗第二条')
    assert(!(await pageText()).includes('会话累计'))
    assert(!(await pageText()).includes('deepseek-flash'))
    await evaluate('document.querySelector("textarea").blur(); document.querySelector("textarea").focus(); document.querySelector("textarea").click()')
    assert.equal(await evaluate('window.overlayFocus.at(-1)'), true)
    await send('Emulation.setDeviceMetricsOverride', { width: 260, height: 120, deviceScaleFactor: 1, mobile: true })
    await waitFor(() => evaluate(`(() => {
      const input = document.querySelector('textarea')
      const bounds = input.getBoundingClientRect()
      return innerHeight === 120 && document.activeElement === input && bounds.top >= 0 && bounds.bottom <= innerHeight
    })()`))
    assert.equal(await evaluate('document.querySelector("textarea").value'), '小窗第二条')
    await click('发送')
    await hasText('小窗回复')
    assert(!(await pageText()).includes('第一条回复'))
    assert(requests.at(-1).messages.some(message => JSON.stringify(message).includes('全屏第一条')))
    assert(requests.at(-1).messages.some(message => JSON.stringify(message).includes('小窗第二条')))
    assert.equal(await evaluate('window.overlayFocus.at(-1)'), false)
    const bounds = await evaluate('(() => { const r = document.querySelector("textarea").getBoundingClientRect(); return [r.top, r.bottom, innerHeight] })()')
    assert(bounds[0] >= 0 && bounds[1] <= bounds[2], JSON.stringify(bounds))
    await type('回全屏草稿')
    await evaluate('window.setOverlay(false)')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 790, deviceScaleFactor: 1, mobile: true })
    await hasText('全屏第一条')
    await hasText('小窗第二条')
    await hasText('会话累计')
    assert.equal(await evaluate('document.querySelector("textarea").value'), '回全屏草稿')
    assert.equal(await evaluate('window.previewReplies.length'),2)
    assert.equal(await evaluate('window.previewReplies.at(-1).currentChat'),true)
    assert.equal(await evaluate('window.previewReplies.at(-1).text'),'小窗回复')
    assert.equal(await evaluate('window.previewReplies.at(-1).session'), await evaluate('window.previewReplies[0].session'))
    assert.notEqual(await evaluate('window.previewReplies.at(-1).run'), await evaluate('window.previewReplies[0].run'))

    // Native resize constrains the WebView. The field must also track visual-only keyboard resize.
    await evaluate(`(() => {
      const input = document.querySelector('textarea')
      window.editingInput = input
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      const viewport = window.visualViewport
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => 240 })
      viewport.dispatchEvent(new Event('resize'))
    })()`)
    await waitFor(() => evaluate(`(() => {
      const bounds = window.editingInput.getBoundingClientRect()
      return innerHeight > 240 && document.activeElement === window.editingInput && bounds.top >= 0 && bounds.bottom <= 240
    })()`))
    await send('Input.imeSetComposition', { text: 'shu', selectionStart: 3, selectionEnd: 3 })
    await send('Input.insertText', { text: '输入' })
    await waitFor(() => evaluate('window.editingInput.value === "回全屏草稿输入"'))
    await evaluate(`(() => {
      delete window.visualViewport.height
      window.visualViewport.dispatchEvent(new Event('resize'))
    })()`)
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 174, deviceScaleFactor: 1, mobile: true })
    await waitFor(() => evaluate(`(() => {
      const bounds = window.editingInput.getBoundingClientRect()
      return innerHeight === 174 && document.activeElement === window.editingInput && bounds.top >= 0 && bounds.bottom <= innerHeight
    })()`))
    assert.equal(await evaluate('window.editingInput.value'), '回全屏草稿输入')
    console.log('PASS floating and full chat keep the focused composer visible in short viewports, visual-only IME resize, and composition / commit')
  } catch (error) {
    console.error(await pageText(), JSON.stringify(diagnostics).slice(0, 1600))
    throw error
  }
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
