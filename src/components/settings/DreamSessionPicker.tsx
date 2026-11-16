import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { DREAM_SELECTION_LIMIT, loadDreamCandidates, useDreamState } from '../../services/chat/dream.js'
import { runDreamForCurrentHistory } from '../../services/chat/dreamScheduler.js'
import { saveChatMemory, useChatMemory } from '../../services/chat/memory.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'

type Candidate = Awaited<ReturnType<typeof loadDreamCandidates>>[number]
const PAGE_SIZE = 30

export const DreamSessionPicker = () => {
  const t = useTranslate()
  const memory = useChatMemory()
  const dream = useDreamState()
  const apiKey = useSettings((state) => state.apiKey)
  const sessions = useChatStore((state) => state.sessions)
  const [candidates, setCandidates] = useState<Candidate[]>()
  const [draft, setDraft] = useState<string[] | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [loadError, setLoadError] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'error'>()

  useEffect(() => {
    if (dream.running) {
      return
    }
    let active = true
    setLoadError(false)
    void loadDreamCandidates().then((list) => {
      if (active) {
        setCandidates(list)
      }
    }).catch(() => {
      if (active) {
        setLoadError(true)
      }
    })
    return () => { active = false }
  }, [sessions, memory.checkpoints, memory.skippedSessions, dream.running])

  const firstRun = memory.dreamNeedsSelection || memory.log.length === 0
  const chosen = draft ?? memory.nextDreamSessionIds ?? []
  const selected = new Set(candidates?.filter((session) => chosen.includes(session.id)).map(({ id }) => id))
  const automaticIds = candidates?.filter(({ id, skipped }) => selected.has(id) && !skipped).map(({ id }) => id) ?? []
  const saved = memory.nextDreamSessionIds?.length ?? 0
  const matches = candidates?.filter(({ title }) =>
    title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  )
  const shown = matches?.slice(0, page * PAGE_SIZE)

  const choose = (ids: string[]) => {
    setDraft(ids)
    setSaveStatus(undefined)
  }

  const saveSelection = (ids: string[] | null) => {
    try {
      saveChatMemory({ nextDreamSessionIds: ids })
      setDraft(null)
      setSaveStatus('saved')
    } catch {
      setSaveStatus('error')
    }
  }

  return (
    <>
      <strong>{t('memoryDreamChoose')}</strong>
      {firstRun ? <p>{t('memoryDreamFirstLimit', { limit: DREAM_SELECTION_LIMIT })}</p> : null}
      <label>
        {t('memoryDreamSearch')}
        <input type="search" className={styles.memorySearch} value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(1)
          }} />
      </label>
      <div className={styles.memoryActions}>
        <Button variant="outlined" size="s" disabled={!candidates?.length || dream.running}
          onClick={() => choose(candidates?.filter(({ skipped }) => !skipped)
            .slice(0, DREAM_SELECTION_LIMIT).map(({ id }) => id) ?? [])}>
          {t('memoryDreamRecent', { limit: DREAM_SELECTION_LIMIT })}
        </Button>
        <Button variant="outlined" size="s" disabled={!selected.size || dream.running}
          onClick={() => choose([])}>{t('memoryDreamClear')}</Button>
      </div>
      <p aria-live="polite">{t('memoryDreamSelected', { count: selected.size, limit: DREAM_SELECTION_LIMIT })}</p>
      {loadError ? <p role="alert">{t('memoryRecallFailed')}</p> : null}
      {matches?.length === 0 ? <p>{t(candidates?.length ? 'memoryDreamNoMatch' : 'memoryNoHistory')}</p> : null}
      {shown?.length ? (
        <div className={styles.memoryDreamList}>
          {shown.map(({ id, title, date, skipped }) => (
            <label key={id}>
              <input type="checkbox" checked={selected.has(id)}
                disabled={dream.running || (!selected.has(id) && selected.size >= DREAM_SELECTION_LIMIT)}
                onChange={(event) => {
                  if (event.target.checked) {
                    selected.add(id)
                  } else {
                    selected.delete(id)
                  }
                  choose([...selected])
                }} />
              <span>{title || t('memoryDreamUntitled')}</span>
              <small>{date}{skipped ? ` · ${t('memoryDreamSkipped')}` : ''}</small>
            </label>
          ))}
        </div>
      ) : null}
      {(matches?.length ?? 0) > (shown?.length ?? 0) ? (
        <Button variant="outlined" size="s" onClick={() => setPage((value) => value + 1)}>
          {t('memoryDreamMore')}
        </Button>
      ) : null}
      <div className={styles.memoryActions}>
        <Button variant="outlined" size="m" disabled={!apiKey || dream.running || !selected.size}
          onClick={() => {
            if (apiKey) {
              void runDreamForCurrentHistory(apiKey, undefined, { sessionIds: [...selected] })
            }
          }}>
          {t(dream.running ? 'memoryConsolidating' : 'memoryConsolidate')}
        </Button>
        <Button variant="outlined" size="m" disabled={dream.running || !automaticIds.length}
          onClick={() => saveSelection(automaticIds)}>{t('memoryDreamScheduleSelected')}</Button>
        {saved ? (
          <Button variant="outlined" size="m" disabled={dream.running}
            onClick={() => saveSelection(null)}>{t('memoryDreamCancelSelection')}</Button>
        ) : null}
      </div>
      {saved ? <p>{t('memoryDreamQueued', { count: saved })}</p> : null}
      {saveStatus ? <p role="status">{t(saveStatus === 'saved' ? 'memoryDreamQueueSaved' : 'memorySaveFailed')}</p> : null}
    </>
  )
}
