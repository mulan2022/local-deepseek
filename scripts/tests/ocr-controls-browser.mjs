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

const toolSse=(name,input,id)=>[
 {type:'message_start',message:{}},
 {type:'content_block_start',index:0,content_block:{type:'tool_use',id,name,input}},
 {type:'content_block_stop',index:0},
 {type:'message_delta',delta:{stop_reason:'tool_use'}},
 {type:'message_stop'},
].map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')
const transform=body=>{
 requests.push(body)
 const content=body.messages.at(-1).content
 const result=Array.isArray(content)&&content.find(block=>block.type==='tool_result')
 if(result?.tool_use_id === 'priority-image') return sse('OCR测试', '排队观察已完成')
 if(result && result.tool_use_id.startsWith('obs:')) return sse('观察工具测试', '观察工具完成：' + result.tool_use_id + ':' + result.content)
 if(result) return sse('OCR测试',result.tool_use_id==='plan'?'观察已准备':result.tool_use_id==='expired'?'旧图已清理':'只看需要的第二张')
 const text=typeof content==='string'?content:content.find(block=>block.type==='text')?.text
 if(text?.startsWith('<HEARTBEAT>')){
  const event=JSON.parse(text.split('\n')[1])
  assert.equal(event.mode,'screen_ocr')
  assert(event.task.startsWith('<SCREEN_OBSERVATION'))
  assert(body.system.includes('On OCR wake-ups, respond briefly'))
  assert(!/\p{Script=Han}/u.test(body.system))
  assert(!event.task.includes('respond briefly'))
  if(event.task.includes('等待用户优先的观察')) {
   assert(event.task.includes('PR1'))
   return toolSse('screen_get_images', { image_ids: ['PR1'] }, 'priority-image')
  }
  if(event.task.includes('AI自己停止观察')) return toolSse('phone_screen_observe',{action:'stop'},'obs:self')
  if(event.task.includes('OCR失败测试')) return {rejection:JSON.stringify({error:{message:'mock OCR request failure'}})}
  if(event.task.includes('无需图片')) return sse('OCR测试','HEARTBEAT_OK')
  assert(event.task.includes('A001')&&event.task.includes('A002'))
  assert(body.tools.some(tool=>tool.name==='screen_get_images'))
  assert(!JSON.stringify(content).includes('base64'))
  return toolSse('screen_get_images',{image_ids:['A002']},'select')
 }
 if(text?.includes('用户优先实际输入')) return sse('OCR测试', '收到了用户优先消息')
 if(text?.includes('AI启动观察')) return toolSse('phone_screen_observe',{action:'start'},'obs:start')
 if(text?.includes('AI停止观察')) return toolSse('phone_screen_observe',{action:'stop'},'obs:stop')
 if(text?.includes('AI查询观察')) return toolSse('phone_screen_observe',{action:'status'},'obs:status')
 if(text?.includes('取旧图')) return toolSse('screen_get_images',{image_ids:['A002']},'expired')
 return toolSse('phone_heartbeat',{mode:'interval',value:'60s'},'plan')
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
      if(body.messages.at(-1).content?.some?.(block=>block.tool_use_id==='obs:self')) await pause(2300); if (JSON.stringify(body.messages.at(-1)).includes("忙碌测试")) await pause(500)
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "\nconst fake = {\n  mode: 'off', value: '', sessionId: '', task: '', at: 0, calls: [], done: [], pending: null, shots: [],\n}\nwindow.fake = fake\nwindow.AndroidPhoneTools = {\n  state: () => JSON.stringify({ heartbeat: true, capture: true, captureActive: true, ...fake }),\n  configureHeartbeat(mode, value, task, sessionId) {\n    Object.assign(fake, { mode, value, task, sessionId, at: Date.now() })\n    fake.calls.push({ mode, value, sessionId })\n    return ''\n  },\n  captureFrame() { fake.shots.push(Date.now()); return 'bW9jay1zY3JlZW4=' },\n}\nwindow.AndroidHeartbeat = {\n  pending: () => JSON.stringify(fake.pending),\n  isHeadless: () => false,\n  complete(id, status, text) {\n    fake.done.push({ id, status, text })\n    fake.pending = null\n    window.dispatchEvent(new Event('android-heartbeat'))\n  },\n}\nlocalStorage.setItem('chat-demo:api-key','mock-key')\nlocalStorage.setItem('chat-demo:locale','zh-CN')\n\n  localStorage.setItem('chat-demo:thinking','true')\n  localStorage.setItem('chat-demo:search','true')\n\nObject.assign(fake,{batch:null,images:[],completed:[],ocr:true,ocrBatchChars:500})\nconst oldState=window.AndroidPhoneTools.state\nwindow.AndroidPhoneTools.state=()=>JSON.stringify({...JSON.parse(oldState()),ocr:fake.ocr,ocrBatchChars:fake.ocrBatchChars})\nwindow.AndroidPhoneTools.pendingObservation=()=>JSON.stringify(fake.batch)\nwindow.AndroidPhoneTools.observationBatch=session=>JSON.stringify(fake.batch?.sessionId===session?fake.batch:null)\nwindow.AndroidPhoneTools.observationImage=(batch,id,session)=>{\n fake.images.push({batch,id,session})\n return fake.batch?.id===batch && fake.batch.sessionId===session && fake.batch.frames.some(frame=>frame.id===id) ? btoa('selected-'+id) : ''\n}\nwindow.AndroidPhoneTools.completeObservation=(id,state)=>{\n fake.completed.push({id,state})\n if(state!=='busy'&&fake.batch?.id===id) fake.batch=null\n}\nwindow.AndroidPhoneTools.configureOcr=(session,interval,chars,wait,change)=>{\n fake.config={session,interval,chars,wait,change};fake.ocrSessionId=session;fake.configCount=(fake.configCount||0)+1;fake.ocrBatchChars=chars;return ''\n}\n\nwindow.previewReplies=[];window.AndroidFloatingChat={active:()=>false,open(){},focusInput(){},notifyReply(session,run,text){window.previewReplies.push({session,run,text})}};\nwindow.AndroidPhoneTools.setEnabled=(feature,enabled)=>{fake[feature]=enabled;if(feature==='ocr'&&!enabled)fake.batch=null;};\n" })
  await send('Page.navigate', { url: origin })
  try {

await hasText('Singula')
const hasChatObservationButton = () => evaluate(`Array.from(document.querySelectorAll('button')).some(button =>
  ['开始观察', '停止观察'].some(label => button.textContent.trim() === label || button.getAttribute('aria-label') === label))`)
const toggleFromBall = async (action) => {
  await evaluate(`window.dispatchEvent(new CustomEvent('android-observation-action', { detail: ${JSON.stringify(action)} }))`)
  await waitFor(() => evaluate(`fake.ocr === ${action === 'start'}`))
}
assert.equal(await hasChatObservationButton(), false, 'Welcome view has no observation button')
await type('开始观察')
await click('发送')
await hasText('观察已准备')
const session=await evaluate('fake.sessionId')
assert(session)
assert.equal(await hasChatObservationButton(), false, 'Desktop chat has no observation button')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await waitFor(() => evaluate('!!document.querySelector(\'button[aria-label="打开边栏"]\')'))
assert.equal(await hasChatObservationButton(), false, 'Mobile chat has no observation button')
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false })
await evaluate('fake.batch={id:"ocr:test1",sessionId:fake.sessionId,at:Date.now(),frames:[{id:"A001",at:Date.now(),text:"第一段字幕"},{id:"A002",at:Date.now(),text:"第二段字幕"}]};window.dispatchEvent(new Event("android-screen-observation"))')
await waitFor(()=>evaluate('fake.completed.some(item=>item.id==="ocr:test1"&&item.state==="done")'))
await hasText('只看需要的第二张')
assert.equal(await evaluate('fake.images.length'),1)
assert.equal(await evaluate('fake.images[0].id'),'A002')
assert.equal(await evaluate('fake.batch'),null)
assert.equal(await evaluate('fake.shots.length'),0)
const imageRequest=requests.at(-1)
assert.equal(imageRequest.messages.at(-1).content.find(block=>block.type==='image').source.data,Buffer.from('selected-A002').toString('base64'))
const observationText = await evaluate(`(() => {
  const details = document.querySelector('[data-chat-message-id="ocr:test1"] details')
  details.open = true
  return details.querySelector('pre').innerText
})()`)
assert(observationText.includes('第一段字幕') && observationText.includes('第二段字幕'))
assert(!observationText.includes('SCREEN_OBSERVATION') && !observationText.includes('respond briefly'))
await evaluate('fake.batch={id:"ocr:test2",sessionId:fake.sessionId,at:Date.now(),frames:[{id:"B001",at:Date.now(),text:"无需图片，字幕足够理解"}]};window.dispatchEvent(new Event("android-screen-observation"))')
await waitFor(()=>evaluate('fake.completed.some(item=>item.id==="ocr:test2"&&item.state==="done")'))
assert.equal(await evaluate('fake.images.length'),1)
assert.equal(await evaluate('fake.batch'),null)
await evaluate('fake.batch={id:"ocr:test3",sessionId:fake.sessionId,at:Date.now(),frames:[{id:"C001",at:Date.now(),text:"OCR失败测试"}]};window.dispatchEvent(new Event("android-screen-observation"))')
await waitFor(()=>evaluate('fake.completed.some(item=>item.id==="ocr:test3"&&item.state==="error")'))
assert.equal(await evaluate('fake.batch'),null)

await type('取旧图')
await click('发送')
await hasText('旧图已清理')
assert.equal(await evaluate('fake.images.length'),1)
assert(requests.at(-1).messages.at(-1).content[0].content.includes('Previous image IDs have expired.'))
const saved=await evaluate('new Promise((resolve,reject)=>{const open=indexedDB.open("chat-demo");open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const req=db.transaction("sessions").objectStore("sessions").getAll();req.onerror=()=>reject(req.error);req.onsuccess=()=>{resolve(JSON.stringify(req.result));db.close();};};})')
assert(saved.includes('第一段字幕'))
assert(!saved.includes(Buffer.from('selected-A002').toString('base64')))
await evaluate('(() => {const original=window.fetch;window.fetch=async (url,init)=>{if(init?.body&&!fake.didBusy){const body=JSON.parse(init.body);if(JSON.stringify(body.messages?.at(-1)).includes("忙碌测试")){fake.didBusy=true;fake.batch={id:"ocr:busy",sessionId:fake.sessionId,at:Date.now(),frames:[{id:"D001",at:Date.now(),text:"无需图片，等待聊天结束"}]};window.dispatchEvent(new Event("android-screen-observation"));}}return original(url,init);};})()')
await type('忙碌测试')
await click('发送')
await waitFor(()=>evaluate('fake.completed.some(item=>item.id==="ocr:busy"&&item.state==="busy")'))
await waitFor(()=>evaluate('fake.completed.some(item=>item.id==="ocr:busy"&&item.state==="done")'))
assert.equal(await evaluate('fake.batch'),null)

// The user reply goes first. The same OCR batch and image resume afterward.
await evaluate(`(() => {
  const fetchApi = window.fetch
  window.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    const last = JSON.stringify(body?.messages?.at(-1)) ?? ''
    if (last.includes('等待用户优先的观察') && !fake.priorityOcrStarted) {
      fake.priorityOcrStarted = true
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          fake.priorityOcrAborted = true
          reject(init.signal.reason)
        }, { once: true })
      })
    }
    if (last.includes('用户优先实际输入')) {
      await new Promise(resolve => { fake.releasePrioritySend = resolve })
    }
    return fetchApi(url, init)
  }
  fake.batch = { id: 'ocr:priority', sessionId: fake.sessionId, at: Date.now(),
    frames: [{ id: 'PR1', at: Date.now(), text: '等待用户优先的观察' }] }
  window.dispatchEvent(new Event('android-screen-observation'))
})()`)
await waitFor(() => evaluate('fake.priorityOcrStarted'))
await type('用户优先实际输入')
assert.equal(await evaluate('document.querySelector(\'button[aria-label="发送"]\')?.getAttribute("aria-disabled")'), 'false')
await click('发送')
await waitFor(() => evaluate('fake.priorityOcrAborted && typeof fake.releasePrioritySend === "function"'))
await waitFor(() => evaluate('fake.completed.some(item => item.id === "ocr:priority" && item.state === "busy")'))
assert.equal(await evaluate('fake.ocr'), true)
assert.equal(await evaluate('fake.batch.id'), 'ocr:priority')
assert.equal(await evaluate('document.querySelector(\'button[aria-label="发送"]\')'), null,
  'Cleanup of the canceled OCR round must not clear the user reply in progress')
await evaluate('fake.releasePrioritySend()')
await hasText('收到了用户优先消息')
await waitFor(() => evaluate('fake.completed.some(item => item.id === "ocr:priority" && item.state === "done")'))
await hasText('排队观察已完成')
const foreground = requests.findIndex(request => JSON.stringify(request.messages.at(-1)).includes('用户优先实际输入'))
const resumed = requests.findIndex(request => JSON.stringify(request.messages.at(-1)).includes('等待用户优先的观察'))
assert(foreground >= 0 && resumed > foreground)
assert(!JSON.stringify(requests[foreground].messages).includes('等待用户优先的观察'))
assert(JSON.stringify(requests[resumed].messages).includes('收到了用户优先消息'))
assert.deepEqual(await evaluate('fake.images.filter(image => image.batch === "ocr:priority").map(image => image.id)'), ['PR1'])
assert.deepEqual(await evaluate('fake.completed.filter(item => item.id === "ocr:priority").map(item => item.state)'), ['busy', 'done'])
assert.equal(await evaluate('fake.batch'), null)

assert((await evaluate('window.previewReplies')).some(p=>p.text.includes('只看需要的第二张')))
assert(!(await evaluate('window.previewReplies')).some(p=>p.text==='HEARTBEAT_OK'))
await toggleFromBall('stop')
assert.equal(await evaluate('fake.ocr'), false)
await toggleFromBall('start')
assert.equal(await evaluate('fake.ocr'), true)
assert.equal(await evaluate('fake.config.session'),session)

await evaluate('fake.delayObservation=false;fake.cancelledObservation=false;(() => { const original=window.fetch;window.fetch=async(url,init)=>{if(init?.body&&JSON.stringify(JSON.parse(init.body).messages?.at(-1)).includes("取消中的观察")){fake.delayObservation=true;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,10000);init.signal.addEventListener("abort",()=>{clearTimeout(timer);fake.cancelledObservation=true;reject(new DOMException("Aborted","AbortError"));},{once:true});});}return original(url,init);};})()')
const beforeCancel=requests.length
const beforePreviews=await evaluate('window.previewReplies.length')
await evaluate('fake.batch={id:"ocr:cancel",sessionId:fake.sessionId,at:Date.now(),frames:[{id:"E001",at:Date.now(),text:"取消中的观察"}]};window.dispatchEvent(new Event("android-screen-observation"))')
await waitFor(()=>evaluate('fake.delayObservation'))
await toggleFromBall('stop')
await waitFor(()=>evaluate('fake.cancelledObservation'))
await waitFor(()=>evaluate('fake.completed.some(item=>item.id==="ocr:cancel"&&item.state==="error")'))
assert.equal(requests.length,beforeCancel)
assert.equal(await evaluate('window.previewReplies.length'),beforePreviews)
assert.equal(await evaluate('fake.batch'),null)
await toggleFromBall('start')
assert.equal(await evaluate('fake.ocrSessionId'),session)
await toggleFromBall('stop')
await type('AI启动观察')
await click('发送')
await hasText('观察工具完成：obs:start:')
assert.equal(await evaluate('fake.ocr'),true)
assert.equal(await evaluate('fake.ocrSessionId'),session)
assert(requests.at(-1).tools.some(tool=>tool.name==='phone_screen_observe'))
const configs=await evaluate('fake.configCount')
await type('AI启动观察')
await click('发送')
await waitFor(()=>evaluate('Array.from(document.querySelectorAll("[data-chat-message-id]")).filter(el=>el.innerText.includes("观察工具完成：obs:start:")&&el.querySelector("button[aria-label=收藏回复]")).length===2'))
assert.equal(await evaluate('fake.configCount'),configs,'Repeated starts do not reset OCR baseline or cache')
await type('AI查询观察')
await click('发送')
await hasText('观察工具完成：obs:status:')
assert((await pageText()).includes('"enabled":true'))
await type('AI停止观察')
await click('发送')
await hasText('观察工具完成：obs:stop:')
assert.equal(await evaluate('fake.ocr'),false)
assert(requests.at(-1).tools.some(tool=>tool.name==='screen_get_images'),'Tool schemas remain stable across OCR toggle')
// AI cannot request screen-sharing consent or take over another chat.
await evaluate('fake.captureActive=false')
await type('AI启动观察')
await click('发送')
await hasText('The user must grant Android screen capture consent first.')
assert.equal(await evaluate('fake.ocr'),false)
await evaluate('fake.ocr=true;window.AndroidPhoneTools.startCapture=()=>{fake.captureConsents=(fake.captureConsents||0)+1;fake.captureActive=true;};window.dispatchEvent(new CustomEvent("android-observation-action",{detail:"start"}))')
await waitFor(()=>evaluate('fake.captureActive===true'))
assert.equal(await evaluate('fake.captureConsents'),1,'User start recovers expired screen-sharing consent even when OCR had stayed enabled')
await evaluate('fake.captureActive=true;fake.ocr=true;fake.ocrSessionId="other-conversation";window.dispatchEvent(new Event("phone-settings-change"))')
await type('AI停止观察')
await click('发送')
await hasText('This tool can stop observation only in the current conversation.')
assert.equal(await evaluate('fake.ocr'),true)
assert.equal(await evaluate('fake.ocrSessionId'),'other-conversation')
await evaluate('fake.ocrSessionId=fake.sessionId;window.dispatchEvent(new Event("phone-settings-change"));fake.batch={id:"ocr:selfstop",sessionId:fake.sessionId,at:Date.now(),frames:[{id:"F001",at:Date.now(),text:"AI自己停止观察"}]};window.dispatchEvent(new Event("android-screen-observation"))')
await waitFor(()=>evaluate('fake.completed.some(item=>item.id==="ocr:selfstop"&&item.state==="done")'))
await hasText('观察工具完成：obs:self:')
assert.equal(await evaluate('fake.ocr'),false)
assert.equal(await evaluate('fake.batch'),null)
await toggleFromBall('start')
await click('设置')
await click('手机工具')
await hasText('累计文字触发字数')
const defaultChars=await evaluate('Array.from(document.querySelectorAll("label")).find(el=>el.innerText.includes("累计文字触发字数")).querySelector("input").value')
assert.equal(defaultChars,'500')
await evaluate('(() => {const el=Array.from(document.querySelectorAll("label")).find(el=>el.innerText.includes("累计文字触发字数")).querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"600");el.dispatchEvent(new Event("input",{bubbles:true}));})()')
await click('保存 OCR 设置')
await hasText('OCR 设置已保存')
assert.equal(await evaluate('fake.config.chars'),600)
console.log('PASS AI start/stop/status with stable schemas, own-round graceful stop, consent and session guards, short OCR prompt, ball start/stop, quick start/stop, in-flight cancellation before network dispatch, quiet reply previews, OCR observation continues same chat; text-only initial batch, AI selects only A002, cleanup on success/quiet/error, no automatic screenshots, settings default 500, custom threshold, busy queue retry, stale IDs rejected, OCR text persisted without image bytes')
  } catch (error) {
    console.error(await pageText(), JSON.stringify(diagnostics).slice(0, 1600))
    throw error
  }
} finally {
  socket?.close()
  browser.kill()
  server.close()
}
