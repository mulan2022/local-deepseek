import { createId } from '../../utils/id.js'
import { getActiveFolderId, readFolderValue, writeFolderValue } from '../chat/folderStorage.js'

export type PhoneFeature = 'capture' | 'intents' | 'heartbeat' | 'ocr'

export type PhoneToolsState = Record<PhoneFeature, boolean> & {
  captureActive: boolean
  captureStatus: string
  captureMessage: string
  ocrSessionId: string
  ocrIntervalSeconds: number
  ocrBatchChars: number
  ocrWaitSeconds: number
  ocrChangePercent: number
  ocrStatus: string
  ocrFrames: number
  ocrBytes: number
  mode: 'off' | 'interval' | 'daily' | 'at' | 'after'
  value: string
  task: string
  sessionId: string
  nextAt: number
  lastAt: number
  lastResult: string
  lastFailed: boolean
}

declare global {
  interface Window {
    AndroidPhoneTools?: {
      state(): string
      setFolder?(folderId: string): void
      copyFolder?(sourceFolderId: string, targetFolderId: string): void
      deleteFolder?(folderId: string): void
      setEnabled(feature: PhoneFeature, enabled: boolean): void
      startCapture(): void
      stopCapture(): void
      captureFrame(): string
      captureStatus?(): string
      configureOcr?(sessionId: string, intervalSeconds: number, batchChars: number, waitSeconds: number, changePercent: number): string
      pendingObservation?(): string
      observationBatch?(sessionId: string): string
      observationImage?(batchId: string, imageId: string, sessionId: string): string
      completeObservation?(batchId: string, status: 'done' | 'busy' | 'error'): void
      configureHeartbeat(mode: string, value: string, task: string, sessionId: string): string
      requestNotifications(): void
      runIntent(action: string, args: string, requestId: string): string
    }
    AndroidHeartbeat?: {
      isHeadless(): boolean
      pending(): string
      complete(id: string, status: 'done' | 'busy' | 'error', result: string): void
    }
  }
}

export const getPhoneBridge = () =>
  typeof window === 'undefined' ? undefined : window.AndroidPhoneTools

export type HeartbeatSchedule = Pick<PhoneToolsState, 'mode' | 'value' | 'task' | 'sessionId'>

export const maxHeartbeatSeconds = 604_800
export const isHeartbeatDuration = (mode: HeartbeatSchedule['mode']) => mode === 'interval' || mode === 'after'

export const heartbeatSeconds = (value: string) =>
  value.endsWith('s') ? Number(value.slice(0, -1)) : Number(value) * 60

export const validHeartbeatTime = (mode: HeartbeatSchedule['mode'], value: string) => {
  if (mode === 'off') {
    return true
  }
  if (isHeartbeatDuration(mode)) {
    const seconds = heartbeatSeconds(value)
    return /^\d+s?$/.test(value) && seconds >= 1 && seconds <= maxHeartbeatSeconds
  }
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

const SETTINGS_KEY = 'chat-demo:phone-tools'
export const phoneSettingsChangeEvent = 'phone-settings-change'
const noSchedule: HeartbeatSchedule = { mode: 'off', value: '', task: '', sessionId: '' }

export const readPhoneTools = (folderId = getActiveFolderId()): PhoneToolsState => {
  const defaults: PhoneToolsState = {
    capture: false, intents: false, heartbeat: false, ocr: false, captureActive: false, captureStatus: '', captureMessage: '',
    ocrSessionId: '', ocrIntervalSeconds: 1, ocrBatchChars: 500, ocrWaitSeconds: 15,
    ocrChangePercent: 60, ocrStatus: '', ocrFrames: 0, ocrBytes: 0,
    ...noSchedule, nextAt: 0, lastAt: 0, lastResult: '', lastFailed: false,
  }
  try {
    const stored = getPhoneBridge()?.state() ?? readFolderValue(folderId, SETTINGS_KEY)
    return { ...defaults, ...JSON.parse(stored ?? '{}') }
  } catch {
    return defaults
  }
}

export const activatePhoneToolsFolder = (folderId: string) => {
  getPhoneBridge()?.setFolder?.(folderId)
  window.dispatchEvent(new Event(phoneSettingsChangeEvent))
}

export const copyPhoneToolsFolder = (sourceFolderId: string, targetFolderId: string) => {
  getPhoneBridge()?.copyFolder?.(sourceFolderId, targetFolderId)
}

export const deletePhoneToolsFolder = (folderId: string) => {
  getPhoneBridge()?.deleteFolder?.(folderId)
}

const saveBrowserPhoneTools = (update: Partial<PhoneToolsState>) => {
  try {
    const folderId = getActiveFolderId()
    writeFolderValue(folderId, SETTINGS_KEY, JSON.stringify({ ...readPhoneTools(folderId), ...update }))
    window.dispatchEvent(new Event(phoneSettingsChangeEvent))
    return true
  } catch {
    return false
  }
}

export const setPhoneFeature = (feature: PhoneFeature, enabled: boolean) => {
  const bridge = getPhoneBridge()
  if (bridge) {
    bridge.setEnabled(feature, enabled)
    window.dispatchEvent(new Event(phoneSettingsChangeEvent))
    return true
  }
  return saveBrowserPhoneTools({
    [feature]: enabled,
    ...(feature === 'heartbeat' && !enabled ? noSchedule : {}),
  })
}

export const savePhoneSchedule = (schedule: HeartbeatSchedule) => {
  const bridge = getPhoneBridge()
  if (bridge) {
    const { mode, value, task, sessionId } = schedule
    return bridge.configureHeartbeat(mode, value, task, sessionId)
  }
  return saveBrowserPhoneTools(schedule.mode === 'off' ? noSchedule : schedule) ? '' : null
}

export type OcrSettings = Pick<PhoneToolsState, 'ocrSessionId' | 'ocrIntervalSeconds' | 'ocrBatchChars' | 'ocrWaitSeconds' | 'ocrChangePercent'>
export const saveOcrSettings = (value: OcrSettings) => {
  const ranges = [
    [value.ocrIntervalSeconds, 1, 60], [value.ocrBatchChars, 50, 10000],
    [value.ocrWaitSeconds, 1, 120], [value.ocrChangePercent, 5, 100],
  ] as const
  if (!value.ocrSessionId || ranges.some(([n, min, max]) => !Number.isInteger(n) || n < min || n > max)) {
    return 'OCR 参数无效'
  }
  const bridge = getPhoneBridge()
  if (bridge) {
    return bridge.configureOcr?.(value.ocrSessionId, value.ocrIntervalSeconds, value.ocrBatchChars,
      value.ocrWaitSeconds, value.ocrChangePercent) ?? '请安装支持 OCR 的安卓客户端'
  }
  return saveBrowserPhoneTools(value) ? '' : '无法保存 OCR 设置'
}

export const runPhoneIntent = (action: string, args: string, signal: AbortSignal): Promise<string> => {
  const bridge = getPhoneBridge()
  if (!bridge) {
    return Promise.resolve('手机快捷操作不可用')
  }
  const id = createId()
  return new Promise((resolve) => {
    const finish = (error: string) => {
      window.clearTimeout(timeout)
      window.removeEventListener('android-intent-result', onResult)
      signal.removeEventListener('abort', onAbort)
      resolve(error)
    }
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; error?: string }>).detail
      if (detail?.id === id) {
        finish(detail.error ?? '无法打开此系统界面')
      }
    }
    const onAbort = () => finish('手机操作已取消')
    const timeout = window.setTimeout(() => finish('手机操作执行超时'), 10_000)
    window.addEventListener('android-intent-result', onResult)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    try {
      const error = bridge.runIntent(action, args, id)
      if (error) {
        finish(error)
      }
    } catch {
      finish('无法调用手机快捷操作')
    }
  })
}
