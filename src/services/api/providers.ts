export const providers = {
  deepseek: {
    name: 'DeepSeek',
    base: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  kimi: { name: 'Kimi', base: 'https://api.moonshot.cn/v1', models: [] },
  claude: { name: 'Claude', base: 'https://api.anthropic.com/v1', models: [] },
  openai: { name: 'OpenAI / ChatGPT', base: 'https://api.openai.com/v1', models: [] },
  gemini: {
    name: 'Gemini / Google',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [],
  },
  glm: {
    name: 'GLM / 智谱',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5', 'glm-4.7', 'glm-4.7-flash'],
  },
  qwen: {
    name: 'Qwen / 通义千问',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-flash'],
  },
  custom: { name: '自定义 / OpenAI 兼容', base: '', models: [] },
} satisfies Record<string, { name: string; base: string; models: string[] }>

export type ProviderId = keyof typeof providers
export type ModelSelection = { provider: ProviderId; model: string }
export type ProviderProfile = { apiKey?: string; base?: string; models?: string[] }

export const providerIds = Object.keys(providers) as ProviderId[]
export const isProvider = (value: unknown): value is ProviderId =>
  typeof value === 'string' && Object.hasOwn(providers, value)

export const defaultModel: ModelSelection = { provider: 'deepseek', model: 'deepseek-flash' }

export const usesDeepSeekWebTools = ({ provider, model }: ModelSelection) =>
  provider === 'deepseek' && model === 'deepseek-flash'

/** Official providers allow known hosts; custom relays use an explicit HTTPS base URL. */
export const validProviderBase = (provider: ProviderId, value: string): string | undefined => {
  const base = value.trim().replace(/\/+$/, '')
  if (provider === 'custom' || provider === 'openai' || provider === 'claude') {
    try {
      const url = new URL(base)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
        return base
      }
    } catch {
      // The settings form keeps the value editable until a valid URL is entered.
    }
    return undefined
  }
  if (base === providers[provider].base) {
    return base
  }
  if (provider === 'kimi' && base === 'https://api.moonshot.ai/v1') {
    return base
  }
  if (provider === 'glm' && base === 'https://api.z.ai/api/paas/v4') {
    return base
  }
  if (
    provider === 'qwen' &&
    /^https:\/\/(?:dashscope-(?:intl|us)\.aliyuncs\.com|[a-z0-9-]+\.(?:cn-beijing|cn-hongkong|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1)\.maas\.aliyuncs\.com)\/compatible-mode\/v1$/.test(
      base
    )
  ) {
    return base
  }
  return undefined
}
