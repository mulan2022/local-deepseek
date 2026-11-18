import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import {
  defaultModel, isProvider, validProviderBase, type ModelSelection, type ProviderId, type ProviderProfile,
} from './api/providers.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'
export type CompactSettings = { enabled: boolean; preset: '200000' | '967000' | 'custom'; custom: number }

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  selectedModel: ModelSelection
  providerProfiles: Partial<Record<ProviderId, ProviderProfile>>
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  compact: CompactSettings
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  selectedModel: 'chat-demo:selected-model',
  providerProfiles: 'chat-demo:provider-profiles',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  compact: 'chat-demo:compact',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const readModel = (): ModelSelection => {
  try {
    const value = JSON.parse(read(KEYS.selectedModel) ?? 'null')
    if (isProvider(value?.provider) && typeof value.model === 'string' && value.model.trim()) {
      return { provider: value.provider, model: value.model.trim() }
    }
  } catch {
    // Use the default if the saved selection is invalid.
  }
  return defaultModel
}

const readProfiles = (): Settings['providerProfiles'] => {
  try {
    const saved = JSON.parse(read(KEYS.providerProfiles) ?? '{}')
    const profiles: Settings['providerProfiles'] = {}
    for (const [provider, value] of Object.entries(saved ?? {})) {
      if (!isProvider(provider) || !value || typeof value !== 'object') {continue}
      const profile = value as ProviderProfile
      profiles[provider] = {
        apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : undefined,
        base: typeof profile.base === 'string' ? validProviderBase(provider, profile.base) : undefined,
        models: Array.isArray(profile.models)
          ? profile.models.filter((model): model is string => typeof model === 'string')
          : undefined,
      }
    }
    return profiles
  } catch {
    return {}
  }
}

const readCompact = (): CompactSettings => {
  try {
    const saved = JSON.parse(read(KEYS.compact) ?? '{}')
    return {
      enabled: saved?.enabled === true,
      preset: saved?.preset === '967000' || saved?.preset === 'custom' ? saved.preset : '200000',
      custom: Number.isSafeInteger(saved?.custom) && saved.custom > 0 ? saved.custom : 200_000,
    }
  } catch {
    return { enabled: false, preset: '200000', custom: 200_000 }
  }
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  selectedModel: readModel(),
  providerProfiles: readProfiles(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  compact: readCompact(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const getProviderKey = (settings: Settings, provider: ProviderId): string =>
  provider === 'deepseek' ? settings.apiKey ?? '' : settings.providerProfiles[provider]?.apiKey ?? ''

export const setSelectedModel = (selectedModel: ModelSelection) => {
  write(KEYS.selectedModel, JSON.stringify(selectedModel))
  useSettings.setState({ selectedModel })
}

export const setProviderProfile = (provider: ProviderId, profile: ProviderProfile) => {
  const providerProfiles = { ...useSettings.getState().providerProfiles, [provider]: profile }
  write(KEYS.providerProfiles, JSON.stringify(providerProfiles))
  useSettings.setState({ providerProfiles })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setCompactSettings = (update: Partial<CompactSettings>) => {
  const compact = { ...useSettings.getState().compact, ...update }
  write(KEYS.compact, JSON.stringify(compact))
  useSettings.setState({ compact })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
