declare global {
  interface Window {
    AndroidProviderApi?: {
      prepare(url: string, method: string, headers: string, body: string): string
      cancel(id: string): void
    }
  }
}

/** APK makes HTTPS calls on-device so providers need not accept WebView origins via CORS. */
export const providerTransport = async (url: string, init: RequestInit): Promise<Response> => {
  const bridge = window.AndroidProviderApi
  if (!bridge) {
    const parsed = new URL(url)
    const proxy = __PROVIDER_DEV_PATHS__[parsed.origin]
    const localPreview = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
    const target = proxy && localPreview ? `${proxy}${parsed.pathname}${parsed.search}` : url
    return fetch(target, { ...init, redirect: 'error', credentials: 'omit' })
  }
  const { signal } = init
  signal?.throwIfAborted()
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  const id = bridge.prepare(
    url,
    init.method ?? 'GET',
    JSON.stringify(headers),
    String(init.body ?? '')
  )
  if (!id) {
    throw new Error('The Android API transport rejected the request.')
  }
  return fetch(`/_provider_api/${id}`, { signal, cache: 'no-store' }).catch((error: unknown) => {
    bridge.cancel(id)
    throw error
  })
}
