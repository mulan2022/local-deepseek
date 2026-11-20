import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

// Run after pnpm build. Uses a temporary browser profile and mocked model responses.
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

 const transform=body=>{
   requests.push(body)
   return sse('收藏测试','满意答案v'+requests.length)
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
      content = transform(body); if(requests.length===1) await pause(650)
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "\nlocalStorage.setItem('chat-demo:api-key','mock-key')\nlocalStorage.setItem('chat-demo:locale','zh-CN')\nconst seed=indexedDB.open('chat-demo',11)\nseed.onupgradeneeded=()=>{\n const db=seed.result\n for(const name of ['sessions','sessionSummaries','files','sessionsStaging','filesStaging']) db.createObjectStore(name,{keyPath:'id'})\n seed.transaction.objectStore('sessionSummaries').createIndex('fileIds','fileIds',{multiEntry:true})\n const at=Date.now()-100000\n const session={id:'legacy-chat',title:'升级前旧对话',createdAt:at,updatedAt:at,messages:[\n {id:'legacy-user',role:'user',createdAt:at,content:'旧问题',files:[{id:'legacy-file',serverId:null,name:'原件.txt',size:19,isImage:false,mimeType:'text/plain'}]},\n {id:'legacy-reply',role:'assistant',createdAt:at+1,model:'deepseek-flash',status:'done',prefix:true,thinking:false,search:false,blocks:[{type:'text',text:'迁移前满意回复'}]}\n ]}\n seed.transaction.objectStore('sessions').put(session)\n seed.transaction.objectStore('sessionSummaries').put({id:session.id,title:session.title,createdAt:at,updatedAt:at,fileIds:['legacy-file']})\n seed.transaction.objectStore('files').put({id:'legacy-file',blob:new Blob(['attachment-original'],{type:'text/plain'})})\n}\nseed.onsuccess=()=>seed.result.close()\nseed.onerror=()=>{} // Reloading an upgraded database must not downgrade it.\n" })
  await send('Page.navigate', { url: origin })
  try {

const readStore=store=>evaluate('new Promise((resolve,reject)=>{const req=indexedDB.open("chat-demo");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const get=db.transaction('+JSON.stringify(store)+').objectStore('+JSON.stringify(store)+').getAll();get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=()=>reject(get.error)}})')
const capturedBodies=id=>evaluate('(async()=>{const stored=await new Promise((resolve,reject)=>{const open=indexedDB.open("chat-demo");open.onsuccess=()=>{const db=open.result;const get=db.transaction("favoriteSnapshots").objectStore("favoriteSnapshots").get('+JSON.stringify(id)+');get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=()=>reject(get.error)}});return Promise.all((stored.requestCapture?.requests||[]).map(async entry=>({...entry,payload:undefined,body:entry.payload?(entry.payload.encoding==="gzip"?await new Response(entry.payload.body.stream().pipeThrough(new DecompressionStream("gzip"))).text():await entry.payload.body.text()):null})))})()')
const favorite=async text=>{
 await evaluate('Array.from(document.querySelectorAll("[data-chat-message-id]")).find(el=>el.innerText.includes('+JSON.stringify(text)+')).querySelector("button[aria-label=收藏回复]").click()')
}
const openFavorites=()=>evaluate('Array.from(document.querySelectorAll("button")).find(el=>el.innerText.trim().startsWith("收藏 · ")).click()')
const selectTitle=title=>evaluate("Array.from(document.querySelectorAll('div')).find(el=>el.childElementCount===0&&el.textContent.trim()==="+JSON.stringify(title)+"&&el.parentElement?.querySelector('button')).click()")
await hasText('升级前旧对话')
await type('第一轮上下文')
await click('发送')
await pause(100)
assert.equal(await evaluate('document.querySelectorAll("button[aria-label=收藏回复]").length'),0)
await hasText('满意答案v1')
await type('第二轮问题')
await click('发送')
await hasText('满意答案v2')
await favorite('满意答案v2')
await hasText('收藏 · 1')
let summaries=await readStore('favorites')
let snapshots=await readStore('favoriteSnapshots')
assert.equal(summaries.length,1)
assert.equal(snapshots[0].likedText,'满意答案v2')
assert.equal(summaries[0].provider,'deepseek')
assert.equal(summaries[0].model,'deepseek-flash')
assert.equal(summaries[0].contextCount,3)
assert.equal(summaries[0].requestCaptureState,'complete')
assert.equal(summaries[0].requestCount,1)
const firstFavoriteId=summaries[0].id
const inputs=await capturedBodies(firstFavoriteId)
assert.equal(inputs[0].body,rawRequests[1])
assert.equal(inputs[0].httpStatus,200)
assert(!JSON.stringify(inputs[0].headers).includes('mock-key'))
assert(!Object.hasOwn(inputs[0].headers,'x-api-key'))
assert(!inputs[0].body.includes('"requestCapture"'))
assert.deepEqual(snapshots[0].session.messages.map(m=>m.role),['user','assistant','user','assistant'])
assert.equal(snapshots[0].session.messages[0].content,'第一轮上下文')
assert(!JSON.stringify(snapshots).includes('mock-key'))
await openFavorites()
await hasText('修改、删除原对话不会影响收藏')
await evaluate('document.querySelector("article button").click()')
await hasText('已保存本轮实际发出的全部 1 次模型请求')
await click('查看请求 1 的原始 JSON')
await waitFor(()=>evaluate('document.querySelector("textarea[readonly]")?.value === '+JSON.stringify(rawRequests[1])))
await hasText('查看收藏时的上下文（3 条）')
await evaluate('document.querySelector("[role=dialog] details summary").click()')
assert.equal(await evaluate('document.querySelector("[role=dialog] details").open'),true)
assert((await evaluate('document.querySelector("[role=dialog] details").innerText')).includes('第一轮上下文'))
await hasText('第一轮上下文')
writeFileSync(join(bundledWeb,'../build/favorites-desktop.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
await click('关闭')
await evaluate('Array.from(document.querySelectorAll("button[aria-label=重新生成]")).at(-1).click()')
await hasText('满意答案v3')
assert.equal(await evaluate('Array.from(document.querySelectorAll("[data-chat-message-id]")).find(el=>el.innerText.includes("满意答案v3")).querySelector("button[aria-label=收藏回复]").getAttribute("aria-pressed")'),'false')
await favorite('满意答案v3')
await hasText('收藏 · 2')
snapshots=await readStore('favoriteSnapshots')
assert.equal(snapshots.length,2)
assert(snapshots.some(s=>s.likedText==='满意答案v2'))
assert(snapshots.some(s=>s.likedText==='满意答案v3'))
for(const snap of snapshots) assert.equal(snap.session.messages.length,4)
assert(!snapshots.find(s=>s.likedText==='满意答案v3').session.messages.slice(0,-1).some(m=>m.role==='assistant'&&m.blocks.some(b=>b.text==='满意答案v2')))
await type('后续不改变收藏上下文')
await click('发送')
await hasText('满意答案v4')
assert(!JSON.stringify(requests.at(-1)).includes('savedAt'))

// Jump from the list to the exact old reply, then from detail to the newer version.
await openFavorites()
await evaluate('Array.from(document.querySelectorAll("article")).find(el=>el.innerText.includes("满意答案v2")).querySelectorAll("button").forEach(b=>{if(b.innerText.trim()==="跳转到原对话")b.click()})')
await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'))
await hasText('满意答案v2')
assert(!(await pageText()).includes('满意答案v3'))
const favoriteTarget=await evaluate('Array.from(document.querySelectorAll("[data-chat-message-id]")).find(el=>el.innerText.includes("满意答案v2")).getAttribute("data-chat-message-id")')
assert.equal(favoriteTarget,summaries[0].messageId)
await openFavorites()
await evaluate('Array.from(document.querySelectorAll("article button")).find(el=>el.innerText.includes("满意答案v3")).click()')
await click('跳转到原对话')
await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'))
await hasText('满意答案v3')
assert(!(await pageText()).includes('满意答案v2'))
await hasText('满意答案v4')
await evaluate('window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==="favoriteSnapshots")throw new DOMException("mock quota","QuotaExceededError");return window.originalPut.apply(this,args)}')
await favorite('满意答案v4')
await hasText('收藏更改未保存')
assert.equal((await readStore('favorites')).length,2)
assert.equal((await readStore('favoriteSnapshots')).length,2)
await evaluate('IDBObjectStore.prototype.put=window.originalPut')
await selectTitle('升级前旧对话')
await hasText('迁移前满意回复')
await favorite('迁移前满意回复')
await hasText('收藏 · 3')
assert.equal((await readStore('favoriteSnapshots')).find(s=>s.messageId==='legacy-reply').files.length,1)
await send('Page.reload')
await hasText('收藏 · 3')
await click('设置')
await click('数据管理')
await hasText('删除当前文件夹的所有对话')
await evaluate('Array.from(document.querySelectorAll("[role=dialog] button")).find(el=>el.innerText.trim()==="删除").click()')
await hasText('删除后，当前文件夹的所有对话都将被清空且无法找回')
await evaluate('Array.from(document.querySelectorAll("[role=dialog]")).at(-1).querySelectorAll("button").forEach(el=>{if(el.innerText.trim()==="删除当前文件夹的所有对话")el.click()})')
await waitFor(async()=>!(await readStore('sessions')).length)
assert.equal((await readStore('files')).length,0)
assert.equal((await readStore('requestJournals')).length,0)
assert.equal((await readStore('requestPayloads')).length,0)
assert.equal((await capturedBodies(firstFavoriteId))[0].body,rawRequests[1])
assert.equal((await readStore('favorites')).length,3)
const retained=await evaluate('new Promise(resolve=>{const req=indexedDB.open("chat-demo");req.onsuccess=()=>{const db=req.result;const get=db.transaction("favoriteSnapshots").objectStore("favoriteSnapshots").getAll();get.onsuccess=async()=>{const item=get.result.find(s=>s.messageId==="legacy-reply");resolve(await item.files[0].blob.text());db.close()}}})')
assert.equal(retained,'attachment-original')
await click('关闭')
await openFavorites()
await evaluate('Array.from(document.querySelectorAll("article button")).find(el=>el.innerText.includes("迁移前满意回复")).click()')
await hasText('迁移前满意回复')
await click('跳转到原对话')
await hasText('原对话或该回答版本已不存在')
assert(await evaluate('!!document.querySelector("[role=dialog]")'))
await click('取消收藏')
await waitFor(async()=>(await readStore('favorites')).length===2)
assert.equal((await readStore('favoriteSnapshots')).length,2)
await send('Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:true})
await pause(150)
const rect=await evaluate('(()=>{const r=document.querySelector("[role=dialog]").getBoundingClientRect();return{width:r.width,height:r.height,x:r.x,y:r.y}})()')
assert(rect.width<=390&&rect.height<=780&&rect.x>=0&&rect.y>=0,JSON.stringify(rect))
writeFileSync(join(bundledWeb,'../build/favorites-mobile.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
console.log('PASS exact-version jump from list/detail, deleted source retains snapshot; v11 database migration; favorite exact reply version and branch; immutable context/model; independent attachment snapshot; reload; history deletion; cancellation; quota rollback; mobile dialog; no key or API-context pollution')
  } catch (error) {
    console.error(await pageText(), JSON.stringify(diagnostics).slice(0, 1600))
    throw error
  }
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
