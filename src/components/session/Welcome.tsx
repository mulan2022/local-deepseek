import { useIsMobile } from '../../app/viewport.js'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = ({ compact = false }: { compact?: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile && !compact ? <MobileHeader /> : null}
      <div className={clsx(styles.welcome, compact && styles.compact)}>
        {compact ? null : <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>}
        <ChatInput sessionId={null} compact={compact} />
        {isMobile && !compact ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
