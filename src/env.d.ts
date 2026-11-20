declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

declare module '*.md' {
  const text: string
  export default text
}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string
declare const __PROVIDER_DEV_PATHS__: Record<string, string>

interface Window {
  AndroidFloatingChat?: { active(): boolean; open(): void; focusInput(focused: boolean): void; notifyReply?(sessionId: string, runId: string, text: string, currentChat: boolean): void; voiceState?(runId: string, status: string): void }
}

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
