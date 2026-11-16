import { useSettings } from '../settings.js'
import { isDreamDue, runDream, type DreamOptions } from './dream.js'
import { readMemory } from './memory.js'
import { useChatStore } from './store.js'

export const runDreamForCurrentHistory = (apiKey: string, allow = () => true, options: DreamOptions = {}) => {
  const sessions = useChatStore.getState().sessions
  return runDream(apiKey, () => {
    const current = useChatStore.getState()
    return !current.importingHistory && current.sessions === sessions && allow()
  }, options)
}

export const bindDreamScheduler = () => {
  let lastActivity = 0
  const check = () => {
    const state = useChatStore.getState()
    const memory = readMemory()
    const { apiKey } = useSettings.getState()
    const idleSince = Math.max(lastActivity, state.sessions[0]?.updatedAt ?? 0)
    if (state.ready && !state.importingHistory && !Object.keys(state.streaming).length &&
      memory.enabled && memory.autoDream && apiKey && navigator.onLine &&
      ((!memory.dreamNeedsSelection && memory.log.length > 0) || memory.nextDreamSessionIds?.length) &&
      isDreamDue(Date.now(), memory.lastDream, idleSince)) {
      void runDreamForCurrentHistory(apiKey, () => {
        const current = readMemory()
        return current.enabled && current.autoDream &&
          isDreamDue(Date.now(), current.lastDream, idleSince) &&
          !Object.keys(useChatStore.getState().streaming).length
      }, { automatic: true })
    }
  }
  const unsubscribe = useChatStore.subscribe((state, previous) => {
    if (state.streaming !== previous.streaming) {
      lastActivity = Date.now()
    }
    if (state.ready && !previous.ready) {
      check()
    }
  })
  const interval = window.setInterval(check, 5 * 60_000)
  window.addEventListener('focus', check)
  window.addEventListener('online', check)
  document.addEventListener('visibilitychange', check)
  return () => {
    unsubscribe()
    clearInterval(interval)
    window.removeEventListener('focus', check)
    window.removeEventListener('online', check)
    document.removeEventListener('visibilitychange', check)
  }
}
