import { runScheduledHeartbeat } from './store.js'

export const bindAndroidHeartbeat = () => {
  const bridge = window.AndroidHeartbeat
  if (!bridge) {
    return
  }
  let current: { id: string; controller: AbortController } | undefined
  const check = () => {
    const event = JSON.parse(bridge.pending() || 'null') as Parameters<typeof runScheduledHeartbeat>[0] | null
    if (current && event?.id === current.id) {
      return
    }
    current?.controller.abort()
    current = undefined
    if (!event) {
      return
    }
    const controller = new AbortController()
    current = { id: event.id, controller }
    void runScheduledHeartbeat(event, controller.signal).then(({ state, text }) => {
      if (!controller.signal.aborted) {
        bridge.complete(event.id, state, text.slice(0, 4000))
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        bridge.complete(event.id, 'error', 'Heartbeat 无法执行')
      }
    })
  }
  window.addEventListener('android-heartbeat', check)
  check()
}
