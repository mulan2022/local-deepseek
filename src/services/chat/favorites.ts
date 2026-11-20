import { create } from 'zustand'
import * as db from './db.js'
import { createFavoriteSnapshot } from './favoriteSnapshot.js'
import { favoriteId, type FavoriteSummary } from './favoriteTypes.js'
import { useChatStore } from './store.js'

export const useFavorites = create<{
  items: FavoriteSummary[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  pending: Record<string, boolean>
  open: boolean
}>(() => ({ items: [], status: 'idle', pending: {}, open: false }))

let loading: Promise<void> | undefined
export const initFavorites = () => {
  if (useFavorites.getState().status === 'ready') { return Promise.resolve() }
  if (loading) { return loading }
  useFavorites.setState({ status: 'loading' })
  loading = db.loadFavorites().then(items => {
    useFavorites.setState({ items: items.sort((a, b) => b.savedAt - a.savedAt), status: 'ready' })
  }).catch(error => {
    db.reportStorageError('load favorites')(error)
    useFavorites.setState({ status: 'error' })
  }).finally(() => { loading = undefined })
  return loading
}

export const openFavorites = () => {
  useFavorites.setState({ open: true })
  void initFavorites()
}
export const closeFavorites = () => useFavorites.setState({ open: false })

const changeFavorite = async (id: string, action: () => Promise<void>) => {
  if (useFavorites.getState().pending[id]) { return false }
  useFavorites.setState(state => ({ pending: { ...state.pending, [id]: true } }))
  try {
    await action()
    return true
  } catch (error) {
    db.reportStorageError('save favorite')(error)
    return false
  } finally {
    useFavorites.setState(state => ({ pending: Object.fromEntries(Object.entries(state.pending).filter(([key]) => key !== id)) }))
  }
}

export const removeFavorite = (id: string) => changeFavorite(id, async () => {
  await db.deleteFavorite(id)
  useFavorites.setState(state => ({ items: state.items.filter(item => item.id !== id) }))
})

export const toggleFavorite = async (sessionId: string, messageId: string, likedText: string) => {
  await initFavorites()
  if (useFavorites.getState().status !== 'ready') { return false }
  const state = useChatStore.getState()
  const folderId = state.activeFolderId
  const id = favoriteId(folderId, sessionId, messageId)
  if (useFavorites.getState().items.some(item => item.id === id)) { return removeFavorite(id) }
  return changeFavorite(id, async () => {
    if (state.importingHistory || state.streaming[sessionId] || state.compacting[sessionId]) {
      throw new Error('Conversation is busy')
    }
    const cached = state.sessionCache[sessionId]
    const session = cached?.folderId === folderId ? cached : await db.loadSession(folderId, sessionId)
    if (!session) { throw new Error('Conversation no longer exists') }
    const { summary, snapshot } = createFavoriteSnapshot(session, messageId, likedText)
    const saved = await db.saveFavorite(summary, snapshot)
    useFavorites.setState(current => ({ items: [saved, ...current.items.filter(item => item.id !== id)] }))
  })
}
