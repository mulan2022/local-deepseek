import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { decodeRequestPayload } from '../../services/api/requestCapture.js'
import type { FavoriteSnapshot } from '../../services/chat/favoriteTypes.js'
import { Button } from '../base/Button.js'
import styles from './FavoritesDialog.module.css'

export const RequestCaptureView = ({ capture }: { capture: FavoriteSnapshot['requestCapture'] }) => {
  const t = useTranslate()
  const [selected, setSelected] = useState<number | null>(null)
  const [body, setBody] = useState<{ text: string } | 'error' | null>(null)
  useEffect(() => {
    setBody(null)
    const payload = selected === null ? undefined : capture?.requests[selected]?.payload
    if (!payload) { return }
    let closed = false
    void decodeRequestPayload(payload).then(text => {
      if (!closed) { setBody({ text }) }
    }).catch(() => { if (!closed) { setBody('error') } })
    return () => { closed = true }
  }, [capture, selected])
  return (
    <section className={styles.context}>
      <p>{t(capture?.state === 'complete' ? 'favoriteRequestsComplete'
        : capture?.state === 'partial' ? 'favoriteRequestsPartial' : 'favoriteRequestsUnavailable',
      { count: capture?.requests.length ?? 0 })}</p>
      {capture?.requests.map((entry, index) => <div key={entry.id} className={styles.contextMessage}>
        <p className={styles.meta}>{index + 1}. {entry.method} {entry.url} · {entry.httpStatus ?? entry.outcome}</p>
        {entry.payload ? <Button size="s" variant="outlined" onClick={() => setSelected(selected === index ? null : index)}>
          {t('favoriteRequestBody', { number: index + 1 })}
        </Button> : <p>{t('favoriteRequestMissing')}</p>}
        {selected === index ? body === 'error' ? <p role="alert">{t('favoritesLoadFailed')}</p>
          : body ? <>
            <pre className={styles.requestHeaders}>{JSON.stringify(entry.headers, null, 2)}</pre>
            <textarea className={styles.requestBody} aria-label={t('favoriteRequestBody', { number: index + 1 })}
              readOnly rows={14} value={body.text} spellCheck={false} />
          </> : <p role="status">{t('sessionLoading')}</p> : null}
      </div>)}
    </section>
  )
}
