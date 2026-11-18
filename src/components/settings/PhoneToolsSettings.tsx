import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getPhoneBridge, phoneSettingsChangeEvent, readPhoneTools, savePhoneSchedule, setPhoneFeature, validHeartbeatTime,
  heartbeatSeconds, isHeartbeatDuration, maxHeartbeatSeconds,
  type HeartbeatSchedule, type PhoneFeature,
} from '../../services/api/phoneBridge.js'
import { useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { openCapturePreview } from './CapturePreview.js'
import styles from './Settings.module.css'

export const PhoneToolsSettings = () => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const bridge = getPhoneBridge()
  const [state, setState] = useState(readPhoneTools)
  const [draft, setDraft] = useState<HeartbeatSchedule | null>(null)
  const [feedback, setFeedback] = useState('')
  const schedule: HeartbeatSchedule = draft ?? {
    mode: state.mode, value: state.value, task: state.task, sessionId: state.sessionId || activeId || '',
  }
  const validSession = sessions.some(({ id }) => id === schedule.sessionId)
  const usesSeconds = isHeartbeatDuration(schedule.mode)

  useEffect(() => {
    const refresh = () => setState(readPhoneTools())
    const timer = bridge ? window.setInterval(refresh, 1_500) : undefined
    window.addEventListener(phoneSettingsChangeEvent, refresh)
    window.addEventListener('storage', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(phoneSettingsChangeEvent, refresh)
      window.removeEventListener('storage', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [bridge])

  const toggle = (feature: PhoneFeature, enabled: boolean) => {
    const saved = setPhoneFeature(feature, enabled)
    if (feature === 'heartbeat') {
      setDraft(null)
    }
    setFeedback(saved ? '' : t('phoneSettingsSaveFailed'))
    setState(readPhoneTools())
  }

  const save = (value: HeartbeatSchedule) => {
    const error = savePhoneSchedule(value)
    setFeedback(error ?? t('phoneSettingsSaveFailed'))
    if (error === '') {
      setFeedback(t(bridge ? 'phoneHeartbeatSaved' : 'phoneHeartbeatSavedLocally'))
      setDraft(null)
    }
    setState(readPhoneTools())
  }

  return (
    <div className={styles.memorySettings}>
      <p>{t(bridge ? 'phoneProviderNote' : 'phoneBrowserSettingsNote')}</p>
      {window.AndroidFloatingChat ? (
        <div className={styles.memoryActions}>
          <Button variant="outlined" size="s" onClick={() => window.AndroidFloatingChat?.open()}>
            {t('floatingChatOpen')}
          </Button>
        </div>
      ) : null}
      <label>
        <input type="checkbox" checked={state.capture} onChange={(e) => toggle('capture', e.target.checked)} />
        {' '}{t('phoneScreenCapture')}
      </label>
      {bridge ? <p>{t('phoneScreenDescription')}</p> : null}
      {bridge && state.capture ? (
        <div className={styles.memoryActions}>
          <Button variant="outlined" size="s" onClick={() => {
            if (state.captureActive) {
              bridge.stopCapture()
            } else {
              bridge.startCapture()
            }
          }}>
            {t(state.captureActive ? 'phoneCaptureStop' : 'phoneCaptureAuthorize')}
          </Button>
          {state.captureActive ? <span role="status">{t('phoneCaptureActive')}</span> : null}
          {state.captureActive ? (
            <Button variant="outlined" size="s" onClick={openCapturePreview}>{t('phoneCapturePreview')}</Button>
          ) : null}
        </div>
      ) : null}
      <label>
        <input type="checkbox" checked={state.intents} onChange={(e) => toggle('intents', e.target.checked)} />
        {' '}{t('phoneIntents')}
      </label>
      {bridge ? <p>{t('phoneIntentDescription')}</p> : null}
      <label>
        <input type="checkbox" checked={state.heartbeat} onChange={(e) => toggle('heartbeat', e.target.checked)} />
        {' '}{t('phoneHeartbeat')}
      </label>
      {state.heartbeat ? (
        <>
          <p>{t('phoneHeartbeatDescription')}</p>
          <p>{t('phoneHeartbeatToolHint')}</p>
          <label>
            {t('phoneHeartbeatMode')}{' '}
            <select value={schedule.mode} onChange={(event) => {
              const mode = event.target.value as HeartbeatSchedule['mode']
              const value = isHeartbeatDuration(mode) ? '60s' : mode === 'off' ? '' : '09:00'
              setDraft({ ...schedule, mode, value })
            }}>
              <option value="off">{t('phoneHeartbeatOff')}</option>
              <option value="interval">{t('phoneHeartbeatInterval')}</option>
              <option value="after">{t('phoneHeartbeatAfter')}</option>
              <option value="at">{t('phoneHeartbeatAt')}</option>
              <option value="daily">{t('phoneHeartbeatDaily')}</option>
            </select>
          </label>
          {schedule.mode !== 'off' ? (
            <>
              <label>
                {t('phoneHeartbeatSession')}{' '}
                <select value={validSession ? schedule.sessionId : ''}
                  onChange={(event) => setDraft({ ...schedule, sessionId: event.target.value })}>
                  <option value="">{t('phoneHeartbeatSelectSession')}</option>
                  {sessions.map(({ id, title }) => <option key={id} value={id}>{title || t('newChat')}</option>)}
                </select>
              </label>
              <label>
                {t(usesSeconds ? 'phoneHeartbeatSeconds' : 'phoneHeartbeatTime')}{' '}
                <input
                  type={usesSeconds ? 'number' : 'time'}
                  min={usesSeconds ? 1 : undefined}
                  max={usesSeconds ? maxHeartbeatSeconds : undefined}
                  value={usesSeconds && schedule.value ? (schedule.value.endsWith('s')
                    ? schedule.value.slice(0, -1) : heartbeatSeconds(schedule.value)) : schedule.value}
                  onChange={(event) => {
                    const value = event.target.value
                    setDraft({ ...schedule, value: usesSeconds && value ? value + 's' : value })
                  }}
                />
              </label>
              <label>
                {t('phoneHeartbeatTask')}
                <textarea rows={3} maxLength={2000} value={schedule.task}
                  onChange={(event) => setDraft({ ...schedule, task: event.target.value })} />
              </label>
            </>
          ) : null}
          <div className={styles.memoryActions}>
            <Button variant="outlined" size="s"
              disabled={schedule.mode !== 'off' && (!validSession || !validHeartbeatTime(schedule.mode, schedule.value))}
              onClick={() => save(schedule)}>{t('phoneHeartbeatSave')}</Button>
            {bridge ? <Button variant="outlined" size="s" onClick={() => bridge.requestNotifications()}>
              {t('phoneHeartbeatNotifications')}
            </Button> : null}
          </div>
          {state.nextAt > 0 ? <p>{t('phoneHeartbeatNext', { time: new Date(state.nextAt).toLocaleString() })}</p> : null}
          {state.lastAt > 0 ? (
            <div>
              <strong>{t(state.lastFailed ? 'phoneHeartbeatLastFailed' : 'phoneHeartbeatLast', {
                time: new Date(state.lastAt).toLocaleString(),
              })}</strong>
              <p style={{ whiteSpace: 'pre-wrap' }}>{state.lastResult || t('phoneHeartbeatQuiet')}</p>
            </div>
          ) : null}
        </>
      ) : null}
      {feedback ? <p role="status">{feedback}</p> : null}
    </div>
  )
}
