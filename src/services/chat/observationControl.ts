import { getPhoneBridge, readPhoneTools, saveOcrSettings, setPhoneFeature } from '../api/phoneBridge.js'

export const observationControlEvent = 'screen-observation-control'

/** The model uses existing capture consent; the user-facing button can request new consent. */
export const controlObservation = (action: 'start' | 'stop', sessionId: string, fromAI = false): string => {
  const state = readPhoneTools()
  const bridge = getPhoneBridge()
  if (action === 'stop') {
    if (fromAI && state.ocr && state.ocrSessionId !== sessionId) {
      return 'Another conversation is observing the screen. This tool can stop observation only in the current conversation.'
    }
    window.dispatchEvent(new CustomEvent(observationControlEvent, { detail: { action, sessionId, fromAI } }))
    return setPhoneFeature('ocr', false) ? '' : fromAI ? 'Could not stop screen observation.' : '无法停止屏幕观察'
  }
  if (!sessionId) { return fromAI ? 'Open a conversation to receive observations.' : '请先打开要接收观察记录的对话' }
  if (fromAI && (!bridge?.configureOcr || !state.capture || !state.captureActive)) {
    return 'The user must grant Android screen capture consent first. They can select Start OCR next to the floating ball.'
  }
  if (fromAI && state.ocr && state.ocrSessionId !== sessionId) {
    return 'Another conversation is observing the screen. The user must stop observation or switch its destination first.'
  }
  if (state.ocr && state.ocrSessionId === sessionId && state.capture && state.captureActive) { return '' }
  const error = saveOcrSettings({ ...state, ocrSessionId: sessionId })
  if (error) { return fromAI ? 'Could not save the screen observation settings.' : error }
  if (!setPhoneFeature('capture', true) || !setPhoneFeature('ocr', true)) {
    return fromAI ? 'Could not start screen observation.' : '无法开启屏幕观察'
  }
  if (!state.captureActive) { bridge?.startCapture() }
  return ''
}
