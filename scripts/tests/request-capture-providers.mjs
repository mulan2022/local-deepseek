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

  const toolSse = (name, input, id) => [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
    { type: 'message_stop' },
  ].map((data) => 'event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n').join('')
  const transform = (body) => {
    if (body.tools?.some((tool) => /^mem_/.test(tool.name))) return sse('', 'NO_TOOL')
    requests.push(body)
    const last = body.messages.at(-1).content
    const text = typeof last === 'string' ? last : last.find(part => part.type === 'text')?.text
    if (!body.tools?.some(tool => tool.name === 'phone_heartbeat')) return sse('旧对话', '旧对话答复')
    if (text?.startsWith('<HEARTBEAT>\n')) {
      const event = JSON.parse(text.split('\n')[1])
      if (event.count === 2) return sse('', 'HEARTBEAT_OK')
      return toolSse('phone_capture', { delay_seconds: '1' }, 'shot')
    }
    if (text?.includes('一起玩')) return toolSse('phone_heartbeat', { mode: 'interval', value: '1' }, 'plan')
    if (last[0]?.tool_use_id === 'plan') return sse('陪玩', '开始陪玩')
    if (last[0]?.tool_use_id === 'shot') return toolSse('phone_heartbeat', { mode: 'after', value: '3' }, 'next')
    if (last[0]?.tool_use_id === 'next') return sse('', '画面看到了')
    return sse('旧对话', '普通消息答复')
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "\n  const provider = localStorage.getItem('test-provider') || 'kimi'\n  const model = {\n    kimi: 'kimi-k3', glm: 'glm-5', qwen: 'qwen-plus', gemini: 'gemini-3-flash',\n    claude: 'claude-sonnet', openai: 'gpt-5', custom: 'custom-test', hunyuan: 'hy4-flash', grok: 'grok-4.7',\n  }[provider]\n  localStorage.setItem('chat-demo:locale', 'zh-CN')\n  localStorage.setItem('chat-demo:selected-model', JSON.stringify({ provider, model }))\n  localStorage.setItem('chat-demo:provider-profiles', JSON.stringify({\n    [provider]: { apiKey: 'mock-key', models: [model], ...(provider === 'custom' ? { base: 'https://example.test/v1' } : {}) },\n  }))\n  const realFetch = window.fetch.bind(window)\n  window.mockBodies = []\n  window.rawBodies = []\n  window.fetch = async (url, options) => {\n    if (options?.method !== 'POST') return realFetch(url, options)\n    window.rawBodies.push(options.body)\n    window.mockBodies.push({ url, ...JSON.parse(options.body) })\n    const answer = '用量测试 ' + provider\n    const request = { prompt_tokens: 1000, completion_tokens: 30 }\n    const usage = provider === 'kimi' ? {\n      ...request, cached_tokens: 350, prompt_tokens_details: { cache_write_tokens: 200 },\n    } : { ...request, prompt_tokens_details: { cached_tokens: 350 } }\n    const frames = provider === 'claude' ? [\n      { type: 'message_start', message: { usage: { input_tokens: 450, cache_read_input_tokens: 350, cache_creation_input_tokens: 200, output_tokens: 1 } } },\n      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: answer } },\n      { type: 'content_block_stop', index: 0 },\n      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } },\n      { type: 'message_stop' },\n    ] : provider === 'openai' || provider === 'grok' ? [\n      { type: 'response.output_text.delta', delta: answer },\n      { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 30, input_tokens_details: { cached_tokens: 350 } } } },\n    ] : [\n      { choices: [{ delta: { content: answer }, finish_reason: null }] },\n      { choices: [{ delta: {}, finish_reason: 'stop' }] },\n      ...(provider === 'custom' ? [] : [{ choices: [], usage }]),\n      '[DONE]',\n    ]\n    return new Response(frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\\n\\n').join(''), {\n      headers: { 'content-type': 'text/event-stream' },\n    })\n  }\n" })
  await send('Page.navigate', { url: origin })
  try {

    for (const provider of ['kimi', 'glm', 'qwen', 'gemini', 'claude', 'openai', 'custom', 'hunyuan', 'grok']) {
      await evaluate('localStorage.setItem("test-provider",' + JSON.stringify(provider) + ')')
      await send('Page.reload')
      await hasText('Singula')
      await type('确认模型用量')
      await click('发送')
      await hasText('用量测试 ' + provider)
      await hasText(provider === 'custom' ? '会话累计 — Token' : '会话累计 1,030 Token')
      await evaluate('Array.from(document.querySelectorAll("summary")).find(el => el.textContent.includes("会话累计")).click()')
      if (provider === 'custom') {
        await hasText('有些回复没有 API 用量记录')
      } else {
        await hasText('输入 1,000（缓存命中 350） · 输出 30')
      }
      const [body] = await evaluate('window.mockBodies')
      if (['kimi', 'glm', 'qwen', 'gemini', 'hunyuan'].includes(provider)) {
        assert.equal(body.stream_options.include_usage, true, provider)
      } else {
        assert.equal(body.stream_options, undefined, provider)
      }
      if (provider === 'hunyuan') {
        assert.equal(body.url, 'https://tokenhub.tencentmaas.com/v1/chat/completions')
        assert(Array.isArray(body.messages) && body.input === undefined)
      }
      if (provider === 'grok') {
        assert.equal(body.url, 'https://api.x.ai/v1/responses')
        assert(Array.isArray(body.input) && body.messages === undefined)
        assert.equal(body.instructions, undefined)
        assert.equal(body.store, false)
      }

      await waitFor(()=>evaluate('document.querySelector("button[aria-label=收藏回复]")?.disabled===false'))
      await click('收藏回复')
      await waitFor(()=>evaluate('document.querySelector("button[aria-label=取消收藏]")?.getAttribute("aria-pressed")==="true"'))
      const capture=await evaluate('new Promise(resolve=>{const r=indexedDB.open("chat-demo");r.onsuccess=()=>{const db=r.result;const g=db.transaction("favoriteSnapshots").objectStore("favoriteSnapshots").getAll();g.onsuccess=async()=>{const s=g.result.find(s=>s.session.messages.at(-1).provider==='+JSON.stringify(provider)+');const entries=await Promise.all(s.requestCapture.requests.map(async item=>({url:item.url,headers:item.headers,body:item.payload.encoding==="gzip"?await new Response(item.payload.body.stream().pipeThrough(new DecompressionStream("gzip"))).text():await item.payload.body.text()})));resolve({state:s.requestCapture.state,entries});db.close()}}})')
      assert.equal(capture.state,'complete',provider)
      assert.deepEqual(capture.entries.map(entry=>entry.body),await evaluate('window.rawBodies'),provider)
      assert.equal(capture.entries[0].url,body.url,provider)
      assert(!JSON.stringify(capture.entries[0].headers).includes('mock-key'),provider)

      if (provider === 'kimi') {
        const session = await evaluate('new Promise((resolve,reject) => { const db=indexedDB.open("chat-demo"); db.onsuccess=()=>{ const req=db.result.transaction("sessions").objectStore("sessions").getAll(); req.onsuccess=()=>resolve(req.result.at(-1)); req.onerror=reject; }; db.onerror=reject; })')
        assert.equal(session.messages.at(-1).usage.cache_creation_input_tokens, 200)
        assert.equal(session.messages.at(-1).usage.input_tokens, 450)
      }
      console.log('PASS ' + provider)
    }
  } catch (error) {
    console.error(await pageText(), JSON.stringify(diagnostics).slice(0, 1600))
    throw error
  }
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
