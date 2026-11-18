import clsx from 'clsx'
import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { addUsage, inputTokens, totalTokens } from '../../services/chat/tokenUsage.js'
import type { MessageUsage } from '../../services/api/types.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { useSettings } from '../../services/settings.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { compactSession, useChatStore } from '../../services/chat/store.js'
import { compactAnchor } from '../../services/chat/compact.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

const ConversationUsage = ({ session, streaming }: { session: Session; streaming: boolean }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const lastReply = getVisibleMessages(session).findLast((message) => message.role === 'assistant')
  const latest = lastReply?.role === 'assistant' ? lastReply.usage : undefined
  let total: MessageUsage | undefined
  let missing = false
  for (const message of session.messages) {
    if (message.role !== 'assistant' || message.status === 'pending' || message.status === 'streaming') {
      continue
    }
    const usage = message.totalUsage ?? message.usage
    if (usage) {
      total = addUsage(total, usage)
    } else if (message.status !== 'error' || message.error?.kind !== 'upload') {
      missing = true
    }
  }
  const format = (tokens: number) => tokens.toLocaleString(locale)
  const breakdown = (usage: MessageUsage) => t('tokenBreakdown', {
    input: format(inputTokens(usage)), output: format(usage.output_tokens),
    cached: format(usage.cache_read_input_tokens),
  })
  return (
    <details className={styles.tokenUsage}>
      <summary>
        {t('tokenConversation', { count: total ? format(totalTokens(total)) : '—' })}
      </summary>
      <div className={styles.tokenDetails}>
        <div>{t('tokenLatest', {
          count: streaming ? t('tokenWaiting') : latest ? format(totalTokens(latest)) : '—',
        })}</div>
        {!streaming && latest ? <div>{breakdown(latest)}</div> : null}
        {total ? <div>{t('tokenTotalDetails', { breakdown: breakdown(total) })}</div> : null}
        {missing ? <div>{t('tokenMissing')}</div> : null}
        <div>{t('tokenScope')}</div>
      </div>
    </details>
  )
}

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
  compact = false,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
  compact?: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  const [confirmSession, setConfirmSession] = useState<string | null>(null)
  const compacting = useChatStore((state) => Object.hasOwn(state.compacting, session.id))
  const compactFailed = useChatStore((state) => state.compactErrors[session.id])
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const history = getVisibleMessages(session)
  const last = history.at(-1)
  const anchor = compactAnchor(history)
  const canCompact = !streaming && !compacting && !replacingHistory && last?.role === 'assistant' &&
    !last.compact && history.some((message) => message.role === 'user' && !message.heartbeat)
  return (
    <div className={styles.view}>
      {compact ? null : isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          {window.AndroidFloatingChat ? (
            <Button size="s" variant="outlined" onClick={() => window.AndroidFloatingChat?.open()}>
              {t('floatingChatOpen')}
            </Button>
          ) : null}
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        busy={streaming || compacting}
        compact={compact}
        footer={
          <div className={clsx(styles.inputContainer, compact && styles.compactInput)}>
            <ChatInput sessionId={session.id} compact={compact} />
            {compact ? null : <div className={styles.footerMeta}>
              <div className={styles.caveat}>{t('contentCaveat')}</div>
              <ConversationUsage key={session.id} session={session} streaming={streaming} />
              <button type="button" className={styles.compactAction} disabled={!canCompact}
                onClick={() => setConfirmSession(session.id)}>
                {t('compactNow')}
              </button>
              {compacting || compactFailed || anchor ? (
                <span role="status">{t(compacting ? 'compactRunning' : compactFailed ? 'compactFailed' : 'compactActive')}</span>
              ) : null}
            </div>}
          </div>
        }
      />
      {confirmSession === session.id ? (
        <Modal title={t('compactConfirmTitle')} onClose={() => setConfirmSession(null)} footer={
          <>
            <Button size="m" variant="outlined" autoFocus onClick={() => setConfirmSession(null)}>{t('cancel')}</Button>
            <Button size="m" disabled={!canCompact} onClick={() => {
              setConfirmSession(null)
              void compactSession(session.id)
            }}>{t('compactNow')}</Button>
          </>
        }>
          {t('compactConfirmBody')}
        </Modal>
      ) : null}
    </div>
  )
}
