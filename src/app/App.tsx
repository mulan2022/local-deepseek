import { useEffect, useState } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { bindDreamScheduler } from '../services/chat/dreamScheduler.js'
import { syncChatMemory } from '../services/chat/memory.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { closeSettings, ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { CapturePreview } from '../components/settings/CapturePreview.js'
import { FavoritesDialog } from '../components/favorites/FavoritesDialog.js'
import { closeFavorites, initFavorites } from '../services/chat/favorites.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { controlObservation } from '../services/chat/observationControl.js'
import { readPhoneTools } from '../services/api/phoneBridge.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { Cosmos } from './Cosmos.js'
import { setSurface } from './theme.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const [floating, setFloating] = useState(() => window.AndroidFloatingChat?.active() ?? false)
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  // 流光与玻璃只留给新对话页，对话中保持简洁实色
  const welcome = !floating && ready && activeId === null

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => setSurface(floating ? 'floating' : welcome ? 'welcome' : 'session'), [floating, welcome])

  useEffect(() => {
    const onFloatingChange = (event: Event) => {
      const status = (event as CustomEvent<string>).detail
      if (status === 'open' || status === 'closed') {
        setFloating(status === 'open')
        if (status === 'open') {
          closeSettings()
          closeMobileSider()
          closeSearchPanel()
          closeFavorites()
        }
      } else if (status === 'denied' || status === 'unavailable') {
        showToast({ key: status === 'denied' ? 'floatingChatPermission' : 'floatingChatUnavailable', type: 'error' })
      }
    }
    const onFloatingSession = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (typeof id === 'string' && useChatStore.getState().sessions.some(session => session.id === id)) {
        selectSession(id)
      }
    }
    const onObservationAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (action !== 'start' && action !== 'stop') { return }
      const state = useChatStore.getState()
      const candidate = state.activeId ?? readPhoneTools().ocrSessionId
      const sessionId = state.sessions.some(session => session.id === candidate) ? candidate : ''
      const error = controlObservation(action, sessionId)
      if (error) { showToast(error) }
    }
    window.addEventListener('android-floating-chat', onFloatingChange)
    window.addEventListener('android-floating-session', onFloatingSession)
    window.addEventListener('android-observation-action', onObservationAction)
    return () => {
      window.removeEventListener('android-floating-chat', onFloatingChange)
      window.removeEventListener('android-floating-session', onFloatingSession)
      window.removeEventListener('android-observation-action', onObservationAction)
    }
  }, [])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])
  useEffect(bindDreamScheduler, [])
  useEffect(() => {
    window.addEventListener('storage', syncChatMemory)
    return () => window.removeEventListener('storage', syncChatMemory)
  }, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat().then(() => {
      // 文件夹配置完成 rehydrate 后，再判断是否缺少当前文件夹的 API Key。
      ensureApiKey()
    })
    void initFavorites()
  }, [])

  return (
    <>
      {welcome ? <Cosmos /> : null}
      <div ref={frameRef} className={styles.frame}>
        {floating ? null : isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {!floating && siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile && !floating ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
                compact={floating}
              />
            ) : (
              <Welcome compact={floating} />
            )}
          </div>
        </main>
        {floating ? null : <SearchPanel />}
      </div>
      <SettingsDialog />
      <FavoritesDialog />
      <CapturePreview />
      <Toast />
    </>
  )
}
