import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listProviderModels } from '../../services/api/providerClient.js'
import {
  providerIds,
  providers,
  validProviderBase,
  type ProviderId,
} from '../../services/api/providers.js'
import {
  getProviderKey,
  setApiKey,
  setProviderProfile,
  setSelectedModel,
  useSettings,
} from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './ModelSettings.module.css'

export const ModelSettings = () => {
  const t = useTranslate()
  const current = useSettings((state) => state.selectedModel)
  const [provider, selectProvider] = useState(current.provider)
  return (
    <div className={styles.form}>
      <label>
        {t('modelProvider')}
        <select
          value={provider}
          onChange={(event) => selectProvider(event.target.value as ProviderId)}
        >
          {providerIds.map((id) => (
            <option key={id} value={id}>
              {providers[id].name}
            </option>
          ))}
        </select>
      </label>
      <ProviderSettings key={provider} provider={provider} />
      <p>{t('modelSharingNotice')}</p>
    </div>
  )
}

const ProviderSettings = ({ provider }: { provider: ProviderId }) => {
  const t = useTranslate()
  const profile = useSettings((state) => state.providerProfiles[provider])
  const savedKey = useSettings((state) => getProviderKey(state, provider))
  const current = useSettings((state) => state.selectedModel)
  const config = providers[provider]
  const [key, setKey] = useState('')
  const [base, setBase] = useState(profile?.base ?? config.base)
  const [models, setModels] = useState(profile?.models ?? config.models)
  const [model, setModel] = useState(
    current.provider === provider ? current.model : (models[0] ?? '')
  )
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const editableBase = ['kimi', 'glm', 'qwen', 'hunyuan', 'openai', 'claude', 'custom'].includes(provider)
  const validBase = validProviderBase(provider, base)
  const apiKey = key.trim() || savedKey
  useEffect(() => () => requestRef.current?.abort(), [])

  const refresh = async () => {
    if (!validBase || !apiKey) {
      return
    }
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setLoading(true)
    setStatus('')
    try {
      const catalog = await listProviderModels(provider, apiKey, controller.signal, validBase)
      if (controller.signal.aborted) {
        return
      }
      setModels(catalog)
      setModel((previous) => previous || catalog[0] || '')
      setStatus(
        catalog.length
          ? t('providerCatalogCount', { count: catalog.length })
          : t('providerCatalogEmpty')
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : ''
        setStatus(message ? `${t('providerCatalogError')} ${message}` : t('providerCatalogError'))
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    }
  }

  return (
    <>
      <label>
        {t('modelApiKey', { provider: config.name })}
        <input
          type="password"
          autoComplete="off"
          value={key}
          disabled={loading}
          placeholder={t(savedKey ? 'modelKeySaved' : 'apiKeyPlaceholder')}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      {editableBase ? (
        <label>
          {t('modelApiBase')}
          <input
            type="url"
            autoComplete="off"
            placeholder={provider === 'custom' ? 'https://example.com/v1' : undefined}
            value={base}
            disabled={loading}
            onChange={(event) => {
              setBase(event.target.value)
              setModels(config.models)
            }}
          />
          {!validBase ? <span role="alert">{t('modelInvalidBase')}</span> : null}
        </label>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="outlined"
          size="s"
          disabled={!apiKey || !validBase || loading}
          onClick={() => void refresh()}
        >
          {t(loading ? 'modelCatalogLoading' : 'modelCatalogRefresh')}
        </Button>
      </div>
      {models.length ? (
        <label>
          {t('modelCatalog')}
          <select
            value={models.includes(model) ? model : ''}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">{t('modelChoose')}</option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        {t('modelId')}
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="m"
          disabled={!validBase || !model.trim() || !apiKey || loading}
          onClick={() => {
            if (!validBase || !model.trim() || !apiKey) {
              return
            }
            if (provider === 'deepseek' && key.trim()) {
              setApiKey(key.trim())
            }
            setProviderProfile(provider, {
              apiKey: provider === 'deepseek' ? undefined : apiKey,
              base: validBase,
              models,
            })
            setSelectedModel({ provider, model: model.trim() })
            setKey('')
            setStatus(t('modelApplied'))
          }}
        >
          {t('modelApply')}
        </Button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </>
  )
}
