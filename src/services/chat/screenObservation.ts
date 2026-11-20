import { getPhoneBridge, phoneSettingsChangeEvent, readPhoneTools } from '../api/phoneBridge.js'
import { runScheduledHeartbeat, useChatStore } from './store.js'
import { observationControlEvent } from './observationControl.js'

export type ScreenObservation = {
  id: string
  sessionId: string
  at: number
  frames: { id: string; at: number; text: string }[]
}

export const observationTask = (batch: ScreenObservation) => [
  '<SCREEN_OBSERVATION batch_id=' + JSON.stringify(batch.id) + '>',
  ...batch.frames.map(frame => '[Image ' + frame.id + ' · ' + new Date(frame.at).toISOString() + ']\n' +
    (frame.text || '(No reliable text)')),
  '</SCREEN_OBSERVATION>',
].join('\n\n')

export const bindAndroidScreenObservation = () => {
  const bridge = getPhoneBridge()
  if (!bridge?.pendingObservation || !bridge.completeObservation) { return }
  let current: { id: string; sessionId: string; finishing?: boolean; controller: AbortController } | undefined
  let retry: { id: string; sessionId: string; at: number } | undefined
  const check = () => {
    // AI-requested stop ends sampling immediately while allowing its own tool round to finish.
    const settings = readPhoneTools()
    if (current?.finishing && settings.capture && !settings.ocr) { return }
    if (!settings.ocr || !settings.capture) {
      current?.controller.abort()
      retry = undefined
      return
    }
    let batch: ScreenObservation | null
    try { batch = JSON.parse(bridge.pendingObservation?.() || 'null') as ScreenObservation | null }
    catch { return }
    if (current) {
      if (batch?.id !== current.id) { current.controller.abort() }
      return
    }
    if (!batch || !Array.isArray(batch.frames) ||
        (retry?.id === batch.id && Date.now() < retry.at)) { return }
    retry = undefined
    const controller = new AbortController()
    current = { id: batch.id, sessionId: batch.sessionId, controller }
    const timeout = window.setTimeout(() => controller.abort(), 180_000)
    const round = { ...batch, at: Date.now(), mode: 'screen_ocr', value: '',
      task: observationTask(batch) }
    void runScheduledHeartbeat(round, controller.signal).then(result => {
      bridge.completeObservation?.(batch.id, result.state)
      if (result.state === 'busy') { retry = { id: batch.id, sessionId: batch.sessionId, at: Date.now() + 5000 } }
    }).catch(() => bridge.completeObservation?.(batch.id, 'error')).finally(() => {
      window.clearTimeout(timeout)
      current = undefined
    })
  }
  window.addEventListener('android-screen-observation', check)
  window.addEventListener(observationControlEvent, (event) => {
    const detail = (event as CustomEvent<{ action: string; sessionId: string; fromAI: boolean }>).detail
    if (detail?.action === 'stop' && current) {
      current.finishing = detail.fromAI && detail.sessionId === current.sessionId
      if (!current.finishing) { current.controller.abort() }
    }
  })
  window.addEventListener(phoneSettingsChangeEvent, check)
  document.addEventListener('visibilitychange', check)
  useChatStore.subscribe((state, previous) => {
    const id = retry?.sessionId
    if (!id || state.streaming[id] || state.compacting[id] || state.importingHistory) { return }
    if (!previous.streaming[id] && !previous.compacting[id] && !previous.importingHistory) { return }
    retry = undefined
    queueMicrotask(check)
  })
  // Native events continue while sharing a screen; polling also covers initial WebView loading.
  window.setInterval(check, 2000)
  check()
}
