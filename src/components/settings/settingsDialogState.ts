import { create } from 'zustand'
import { getProviderKey, useSettings } from '../../services/settings.js'

export type SettingsSection = 'general' | 'models' | 'data' | 'memory' | 'phone'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  const settings = useSettings.getState()
  if (getProviderKey(settings, settings.selectedModel.provider)) {
    return true
  }
  openSettings(settings.selectedModel.provider === 'deepseek' ? 'data' : 'models')
  return false
}
