import { useEffect, useRef } from 'react'
import { transcribe } from '../../services/api/speech.js'
import { useChatStore } from '../../services/chat/store.js'
import { getProviderKey, useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'

/** Android captures audio while the ball is held and publishes the WAV only on release. */
export const useFloatingVoice = (enabled: boolean, onText: (text: string) => void) => {
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  useEffect(() => {
    if (!enabled) { return }
    type Hold = { id: string; key: string; controller?: AbortController }
    let active: Hold | undefined
    const report = (id: string, status: string) => window.AndroidFloatingChat?.voiceState?.(id, status)
    const clear = () => {
      const previous = active
      active = undefined
      if (previous) {
        previous.controller?.abort()
        report(previous.id, 'idle')
      }
    }
    const submitAudio = async (hold: Hold) => {
      const controller = new AbortController()
      const { signal } = controller
      hold.controller = controller
      report(hold.id, 'transcribing')
      let downloaded = false
      try {
        const response = await fetch(`/_floating_voice/${encodeURIComponent(hold.id)}`, { signal, cache: 'no-store' })
        if (!response.ok) { throw new Error('Missing floating recording') }
        const recording = await response.blob()
        downloaded = true
        signal.throwIfAborted()
        const text = (await transcribe(hold.key, recording, signal)).trim()
        if (active !== hold || signal.aborted) { return }
        if (text) { onTextRef.current(text) }
        else { showToast({ key: 'voiceInputEmpty' }) }
      } catch {
        if (!signal.aborted) {
          showToast({ key: downloaded ? 'voiceInputFailed' : 'voiceInputReadFailed', type: 'error' })
        }
      } finally {
        if (active === hold) { clear() }
      }
    }
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{ action: string; id: string }>).detail
      if (!detail || typeof detail.id !== 'string') { return }
      const { action, id } = detail
      if (action === 'start') {
        if (active?.id === id) { return }
        const key = getProviderKey(useSettings.getState(), 'deepseek')
        if (active || !key || useChatStore.getState().importingHistory) {
          if (!key) { showToast({ key: 'voiceInputMissingKey', type: 'error' }) }
          report(id, 'rejected')
          return
        }
        active = { id, key }
        report(id, 'starting')
      } else if (active?.id === id) {
        if (action === 'audio' && !active.controller) { void submitAudio(active) }
        else if (action === 'cancel') { clear() }
        else if (action === 'empty') {
          showToast({ key: 'voiceInputHoldLonger' })
          clear()
        }
      }
    }
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.importingHistory && !previous.importingHistory) { clear() }
    })
    window.addEventListener('android-floating-voice', handle)
    return () => {
      window.removeEventListener('android-floating-voice', handle)
      unsubscribe()
      clear()
    }
  }, [enabled])
}
