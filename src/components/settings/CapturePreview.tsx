import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getPhoneBridge, readPhoneTools } from '../../services/api/phoneBridge.js'
import { Modal } from '../base/Modal.js'

export const capturePreviewEvent = 'android-capture-preview'
export const openCapturePreview = () => window.dispatchEvent(new Event(capturePreviewEvent))

export const CapturePreview = () => {
  const t = useTranslate()
  const [preview, setPreview] = useState<{ data: string; status?: string; message?: string } | null>(null)
  useEffect(() => {
    const open = () => {
      const bridge = getPhoneBridge()
      if (bridge) {
        setPreview({ data: bridge.captureFrame(), status: bridge.captureStatus?.(), message: readPhoneTools().captureMessage })
      }
    }
    window.addEventListener(capturePreviewEvent, open)
    return () => window.removeEventListener(capturePreviewEvent, open)
  }, [])
  if (!preview) {
    return null
  }
  return (
    <Modal title={t('phoneCapturePreview')} closable onClose={() => setPreview(null)}>
      {preview.data ? (
        <img src={'data:image/jpeg;base64,' + preview.data} alt={t('phoneCapturePreview')}
          style={{ display: 'block', maxWidth: '100%', maxHeight: 'max(75px, calc(var(--app-viewport-base-height) - 112px))', margin: 'auto' }} />
      ) : (
        <p>{preview.message || t(preview.status === 'hidden' ? 'phoneCaptureHidden' : preview.status === 'blank'
          ? 'phoneCaptureBlank' : 'phoneCaptureNoFrame')}</p>
      )}
    </Modal>
  )
}
