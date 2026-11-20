import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { providers } from '../../services/api/providers.js'
import { loadFavoriteSnapshot } from '../../services/chat/db.js'
import { closeFavorites, initFavorites, removeFavorite, useFavorites } from '../../services/chat/favorites.js'
import type { FavoriteSnapshot, FavoriteSummary } from '../../services/chat/favoriteTypes.js'
import { getReplyText } from '../../services/chat/reply.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { Markdown } from '../markdown/Markdown.js'
import styles from './FavoritesDialog.module.css'
import { RequestCaptureView } from './RequestCaptureView.js'
import { jumpToSavedReply, useChatStore } from '../../services/chat/store.js'

export const FavoritesDialog = () => {
  const open = useFavorites(state => state.open)
  return open ? <FavoritesContent /> : null
}

const FavoritesContent = () => {
  const t = useTranslate()
  const items = useFavorites(state => state.items)
  const status = useFavorites(state => state.status)
  const pending = useFavorites(state => state.pending)
  const folders = useChatStore(state => state.folders)
  const folderName = (id: string) => folders.find(folder => folder.id === id)?.name ?? t('favoriteFolderMissing')
  const [selected, setSelected] = useState<FavoriteSummary | null>(null)
  const [snapshot, setSnapshot] = useState<FavoriteSnapshot | null | 'error'>(null)
  const [jumping, setJumping] = useState(false)
  useEffect(() => {
    setSnapshot(null)
    if (!selected) { return }
    let disposed = false
    void loadFavoriteSnapshot(selected.id).then(value => {
      if (!disposed) { setSnapshot(value ?? 'error') }
    }).catch(() => {
      if (!disposed) { setSnapshot('error') }
    })
    return () => { disposed = true }
  }, [selected])
  const remove = async (id: string) => {
    if (await removeFavorite(id)) {
      if (selected?.id === id) { setSelected(null) }
    } else { showToast({ key: 'favoriteSaveFailed', type: 'error' }) }
  }
  const jump = async (item: FavoriteSummary) => {
    setJumping(true)
    try {
      const result = await jumpToSavedReply(item.sourceFolderId, item.sessionId, item.messageId)
      if (result === 'done') { closeFavorites() }
      else { showToast({ key: result === 'missing' ? 'favoriteOriginalMissing' : result === 'busy' ? 'favoriteJumpBusy' : 'favoritesLoadFailed', type: 'error' }) }
    } catch { showToast({ key: 'favoritesLoadFailed', type: 'error' }) }
    finally { setJumping(false) }
  }
  return (
    <Modal title={t('favorites')} closable onClose={closeFavorites}
      className={styles.dialog} mainClassName={styles.body}>
      <p className={styles.help}>{t('favoritesHelp')}</p>
      {selected ? (
        <div className={styles.detail}>
          <div className={styles.toolbar}>
            <Button size="s" variant="outlined" onClick={() => setSelected(null)}>{t('favoritesBack')}</Button>
            <Button size="s" variant="outlined" disabled={jumping} onClick={() => void jump(selected)}>{t('favoriteJump')}</Button>
            <Button size="s" variant="outlined" disabled={pending[selected.id]} onClick={() => void remove(selected.id)}>
              {t('favoriteRemove')}
            </Button>
          </div>
          <h2 className={styles.title}>{selected.sessionTitle || t('untitledChat')}</h2>
          <p className={styles.meta}>{folderName(selected.sourceFolderId)} · {providers[selected.provider].name} · {selected.model || '—'} · {new Date(selected.savedAt).toLocaleString()}</p>
          {snapshot === 'error' ? <p role="alert">{t('favoritesLoadFailed')}</p> : snapshot ? <>
            <Markdown content={snapshot.likedText} loading={false} cacheKey={'favorite:' + selected.id} disableLink={false} />
            <RequestCaptureView capture={snapshot.requestCapture} />
            <details className={styles.context}>
              <summary>{t('favoritesContext', { count: selected.contextCount })}</summary>
              {snapshot.session.messages.slice(0, -1).map(message => <div key={message.id} className={styles.contextMessage}>
                <strong>{message.role === 'user' ? t('favoritesUser') : t('favoritesAssistant')}</strong>
                <pre>{message.role === 'user'
                  ? [message.heartbeat?.task || message.content, ...message.files.map(file => file.name)].filter(Boolean).join('\n')
                  : getReplyText(message)}</pre>
              </div>)}
            </details>
          </> : <p role="status">{t('sessionLoading')}</p>}
        </div>
      ) : status === 'error' ? (
        <div role="alert"><p>{t('favoritesLoadFailed')}</p><Button size="s" onClick={() => void initFavorites()}>{t('retry')}</Button></div>
      ) : status !== 'ready' ? <p role="status">{t('sessionLoading')}</p>
        : !items.length ? <p role="status">{t('favoritesEmpty')}</p>
          : <div className={styles.list}>{items.map(item => (
            <article key={item.id} className={styles.card}>
              <button type="button" className={styles.open} onClick={() => setSelected(item)}>
                <span className={styles.title}>{item.sessionTitle || t('untitledChat')}</span>
                <span className={styles.preview}>{item.preview}</span>
                <span className={styles.meta}>{folderName(item.sourceFolderId)} · {providers[item.provider].name} · {item.model || '—'}</span>
              </button>
              <div className={styles.cardFooter}>
                <time>{new Date(item.savedAt).toLocaleString()}</time>
                <Button variant="outlined" size="s" disabled={jumping} onClick={() => void jump(item)}>{t('favoriteJump')}</Button>
                <Button variant="outlined" size="s" disabled={pending[item.id]} onClick={() => void remove(item.id)}>
                  {t('favoriteRemove')}
                </Button>
              </div>
            </article>
          ))}</div>}
    </Modal>
  )
}
