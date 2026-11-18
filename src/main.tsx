import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { bindAndroidHeartbeat } from './services/chat/heartbeat.js'
import './app/theme.css'
import './app/global.css'

const favicon = document.createElement('link')
favicon.rel = 'icon'
favicon.type = 'image/png'
favicon.href = new URL('../android/res/drawable-nodpi/app_icon.png', import.meta.url).href
document.head.append(favicon)

ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
bindAndroidHeartbeat()
