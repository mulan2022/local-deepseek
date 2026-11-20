import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useDreamState } from '../../services/chat/dream.js'
import {
  PINNED_LIMIT, saveChatMemory, SECTION_KEYS, SECTION_LIMIT, useChatMemory, type MemorySection,
} from '../../services/chat/memory.js'
import { buildRecentRecall, loadRecallSessions } from '../../services/chat/recall.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { DreamSessionPicker } from './DreamSessionPicker.js'
import { closeSettings } from './settingsDialogState.js'
import styles from './Settings.module.css'

const layers = {
  pinned: 'memoryPinned',
  sections: 'memorySections',
  observations: 'memoryObservations',
  entities: 'memoryEntities',
  recall: 'memoryRecall',
  dream: 'memoryDream',
} as const satisfies Record<string, TranslationKey>
type Layer = keyof typeof layers

const sectionLabels: Record<MemorySection, TranslationKey> = {
  personal: 'memoryPersonal', work: 'memoryWork', thisMonth: 'memoryThisMonth',
  earlierMonths: 'memoryEarlier', taste: 'memoryTaste', tips: 'memoryTips',
}

const MemorySource = ({ source }: { source: string }) => {
  const t = useTranslate()
  const [id] = source.split(':', 1)
  const title = useChatStore((state) => state.sessions.find((session) => session.id === id)?.title)
  if (title === undefined) {
    return null
  }
  return (
    <Button variant="outlined" size="s" onClick={() => {
      selectSession(id)
      closeSettings()
    }}>{title || t('memorySource')}</Button>
  )
}

const EditMemory = ({ value, limit, save }: {
  value: string; limit: number; save: (value: string) => void
}) => {
  const t = useTranslate()
  const [edited, setEdited] = useState<string>()
  const draft = edited ?? value
  const [status, setStatus] = useState('')
  return (
    <>
      <textarea rows={7} value={draft} maxLength={Math.max(limit, value.length)}
        aria-label={t('memoryEdit')} onChange={(event) => setEdited(event.target.value)} />
      <Button variant="outlined" size="m" disabled={value === draft || draft.length > limit}
        onClick={() => {
          try {
            save(draft)
            setEdited(undefined)
            setStatus(t('memorySaved'))
          } catch {
            setStatus(t('memorySaveFailed'))
          }
        }}>
        {t('memorySave')}
      </Button>
      {status ? <span role="status">{status}</span> : null}
    </>
  )
}

const RecallPreview = () => {
  const t = useTranslate()
  const folderId = useChatStore((state) => state.activeFolderId)
  const [recent, setRecent] = useState<ReturnType<typeof buildRecentRecall>>()
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    void loadRecallSessions(folderId).then((sessions) => {
      if (active) {
        setRecent(buildRecentRecall(sessions).reverse())
      }
    }).catch(() => {
      if (active) {
        setError(true)
      }
    })
    return () => { active = false }
  }, [folderId])
  return (
    <>
      <p>{t('memoryRecallDescription')}</p>
      {error ? <p role="alert">{t('memoryRecallFailed')}</p> : null}
      {recent?.length === 0 ? <p>{t('memoryEmpty')}</p> : null}
      {recent?.map(({ date, title, quotes }, index) => (
        <details key={index}>
          <summary>{date} {title}</summary>
          <ul>{quotes.map((quote, quoteIndex) => <li key={quoteIndex}>{quote}</li>)}</ul>
        </details>
      ))}
    </>
  )
}

export const ChatMemorySettings = () => {
  const t = useTranslate()
  const memory = useChatMemory()
  const dream = useDreamState()
  const [layer, setLayer] = useState<Layer>('pinned')
  const [section, setSection] = useState<MemorySection>('personal')
  const [settingsError, setSettingsError] = useState(false)

  const toggle = (key: 'enabled' | 'autoDream', value: boolean) => {
    try {
      saveChatMemory({ [key]: value })
      setSettingsError(false)
    } catch {
      setSettingsError(true)
    }
  }

  return (
    <section className={styles.memorySettings}>
      <label>
        <input type="checkbox" checked={memory.enabled}
          onChange={(event) => toggle('enabled', event.target.checked)} />
        {' '}{t('chatMemoryEnable')}
      </label>
      <p>{t('chatMemoryDescription')}</p>
      {settingsError ? <p role="alert">{t('memorySaveFailed')}</p> : null}
      <div className={styles.memoryActions} role="group" aria-label={t('chatMemory')}>
        {(Object.keys(layers) as Layer[]).map((id) => (
          <Button key={id} variant={layer === id ? 'primary' : 'outlined'} size="s"
            aria-pressed={layer === id} onClick={() => setLayer(id)}>
            {t(layers[id])}
          </Button>
        ))}
      </div>
      {layer === 'pinned' ? (
        <EditMemory key="pinned" value={memory.pinned} limit={PINNED_LIMIT}
          save={(pinned) => saveChatMemory({ pinned })} />
      ) : null}
      {layer === 'sections' ? (
        <>
          <select aria-label={t('memorySections')} value={section}
            onChange={(event) => setSection(event.target.value as MemorySection)}>
            {SECTION_KEYS.map((id) => <option key={id} value={id}>{t(sectionLabels[id])}</option>)}
          </select>
          <EditMemory key={section} value={memory.sections[section]} limit={SECTION_LIMIT}
            save={(value) => saveChatMemory({ sections: { ...useChatMemory.getState().sections, [section]: value } })} />
        </>
      ) : null}
      {layer === 'observations' ? (
        memory.observations.length ? (
          <ul>{memory.observations.map((item, index) => (
            <li key={index}>
              <strong>{t(item.confidence === 'confirmed' ? 'memoryConfirmed' :
                item.confidence === 'observed' ? 'memoryObserved' : 'memoryTentative')}</strong>
              {' '}{item.text}
              <div><MemorySource source={item.source} /></div>
            </li>
          ))}</ul>
        ) : <p>{t('memoryEmpty')}</p>
      ) : null}
      {layer === 'entities' ? (
        memory.entities.length ? memory.entities.map((entity, index) => (
          <details key={entity.name + index}>
            <summary>{[entity.name, ...entity.aliases].join(' · ')}</summary>
            <p>{entity.text}</p>
            <MemorySource source={entity.source} />
          </details>
        )) : <p>{t('memoryEmpty')}</p>
      ) : null}
      {layer === 'recall' ? <RecallPreview /> : null}
      {layer === 'dream' ? (
        <>
          <label>
            <input type="checkbox" checked={memory.autoDream}
              onChange={(event) => toggle('autoDream', event.target.checked)} />
            {' '}{t('memoryNightDream')}
          </label>
          <p>{t('memoryScheduleDescription')}</p>
          <DreamSessionPicker />
          {dream.result ? <p role="status">{t({
            saved: 'memoryDreamSaved', empty: 'memoryNoHistory', busy: 'memoryDreamBusy',
            failed: 'memoryConsolidationFailed',
            selectionRequired: 'memoryDreamSelectionRequired',
          }[dream.result] as TranslationKey)}</p> : null}
          <strong>{t('memoryDreamLog')}</strong>
          {memory.log.length
            ? <ul>{memory.log.map(({ at, sessions }) =>
                <li key={at}>{new Date(at).toLocaleString()} · {t('memoryDreamCount', { count: sessions })}</li>
              )}</ul>
            : <p>{t('memoryEmpty')}</p>}
        </>
      ) : null}
    </section>
  )
}
